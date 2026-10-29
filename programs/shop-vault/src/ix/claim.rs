//! Owner claims: `request_claim` (disc 2), `cancel_claim` (disc 3), `finalize_claim` (disc 4).
//! SPEC §5.3-§5.5. None of these read pump state or move lamports (D4, I8).

use pinocchio::{AccountView, Address, ProgramResult};

use crate::{
    consts::MAX_GOVERNANCE_SOLO_CANCELS,
    error::{err, VaultError},
    events::*,
    ix::{field, now, require_attestor_scope, require_len, require_signer},
    not_enough_accounts,
    state::{cast, cast_mut, check_config, check_state, Config, VaultState, PENDING_IN_PROBATION},
};

/// Data: `[2] nonce:u64` (9 bytes).
/// Accounts: `0 attestor (S)`, `1 new_owner (S)`, `2 config`, `3 vault_state (W)`, `4 instructions_sysvar`.
pub fn request_claim(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    require_len(data, 9)?;
    let [attestor, new_owner, config, vault_state, ix_sysvar, ..] = accounts else {
        return Err(not_enough_accounts());
    };
    let nonce = u64::from_le_bytes(field(data, 1)?);

    // 1. config, attestor co-signature, new owner proves control of the payout wallet.
    check_config(config, program_id)?;
    let cfg_d = config.try_borrow()?;
    // SAFETY: check_config verified the exact length.
    let cfg: &Config = unsafe { cast(&cfg_d) };
    require_signer(attestor)?;
    if attestor.address().as_array() != &cfg.attestor.current {
        return Err(err(VaultError::AttestorMismatch));
    }
    require_signer(new_owner)?;
    // 1b. the attestor's signature authorizes this one top-level instruction only.
    require_attestor_scope(ix_sysvar, program_id)?;

    // 2. state.
    check_state(vault_state, program_id, true)?;
    let mut st_d = vault_state.try_borrow_mut()?;
    // SAFETY: check_state verified the exact length.
    let st: &mut VaultState = unsafe { cast_mut(&mut st_d) };

    // 3-6.
    if st.has_pending != 0 {
        return Err(err(VaultError::ClaimAlreadyPending));
    }
    if Some(nonce) != st.claim_nonce().checked_add(1) {
        return Err(err(VaultError::BadNonce));
    }
    let new_key = new_owner.address().as_array();
    if new_key == &cfg.attestor.current || new_key == &cfg.governance || new_key == &cfg.guardian.current {
        return Err(err(VaultError::InvalidOwner));
    }
    if st.has_owner != 0 && &st.owner == new_key {
        return Err(err(VaultError::SameOwner));
    }
    // 6. Probation after an attestor change (review finding R2-A1): the claim cannot finalize before the probation
    //    ends plus a full window, and the shop's current owner may cancel it.
    let ts = now()?;
    let probation_until = cfg.probation_until();
    let in_probation = ts < probation_until;
    let unlock = (if in_probation { probation_until } else { ts })
        .checked_add(cfg.claim_window())
        .ok_or_else(|| err(VaultError::ArithmeticOverflow))?;

    // Effects.
    st.pending_owner = *new_key;
    st.unlock_ts = unlock.to_le_bytes();
    st.has_pending = 1;
    st.pending_flags = if in_probation { PENDING_IN_PROBATION } else { 0 };
    st.claim_nonce = nonce.to_le_bytes();
    emit(&[EV_CLAIM_REQUESTED, &st.place_hash, new_key, &st.claim_nonce, &st.unlock_ts]);
    Ok(())
}

/// Data: `[3]`. Accounts: `0 authority (S)`, `1 config`, `2 vault_state (W)`.
/// Roles: the guardian (always; governance can replace a hostile guardian), governance (at most
/// MAX_GOVERNANCE_SOLO_CANCELS times per place, ever, so a hostile or lost-quorum governance cannot freeze a shop
/// forever), the pending claimant (own claim), and the current owner for a claim requested during a probation.
/// Never the attestor, and never the owner otherwise (D6).
pub fn cancel_claim(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    require_len(data, 1)?;
    let [authority, config, vault_state, ..] = accounts else {
        return Err(not_enough_accounts());
    };
    check_config(config, program_id)?;
    check_state(vault_state, program_id, true)?;
    require_signer(authority)?;

    let cfg_d = config.try_borrow()?;
    // SAFETY: lengths verified above.
    let cfg: &Config = unsafe { cast(&cfg_d) };
    let mut st_d = vault_state.try_borrow_mut()?;
    let st: &mut VaultState = unsafe { cast_mut(&mut st_d) };

    if st.has_pending == 0 {
        return Err(err(VaultError::NoPendingClaim));
    }
    if now()? >= st.unlock_ts() {
        return Err(err(VaultError::ClaimWindowElapsed));
    }
    let who = authority.address().as_array();
    let role: u8 = if who == &cfg.guardian.current {
        ROLE_GUARDIAN
    } else if who == &cfg.governance {
        if st.governance_cancels >= MAX_GOVERNANCE_SOLO_CANCELS {
            return Err(err(VaultError::GovernanceCancelLimit));
        }
        st.governance_cancels += 1;
        ROLE_GOVERNANCE
    } else if who == &st.pending_owner {
        ROLE_CLAIMANT
    } else if st.has_owner != 0 && who == &st.owner && st.pending_flags & PENDING_IN_PROBATION != 0 {
        ROLE_OWNER_IN_PROBATION
    } else {
        return Err(err(VaultError::Unauthorized));
    };

    // Effects: the nonce stays consumed.
    st.clear_pending();
    emit(&[EV_CLAIM_CANCELLED, &st.place_hash, who, &[role], &st.claim_nonce]);
    Ok(())
}

/// Data: `[4]`. Accounts: `0 vault_state (W)`. Permissionless once `now >= unlock_ts`.
pub fn finalize_claim(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    require_len(data, 1)?;
    let [vault_state, ..] = accounts else {
        return Err(not_enough_accounts());
    };
    check_state(vault_state, program_id, true)?;
    let mut st_d = vault_state.try_borrow_mut()?;
    // SAFETY: check_state verified the exact length.
    let st: &mut VaultState = unsafe { cast_mut(&mut st_d) };
    if st.has_pending == 0 {
        return Err(err(VaultError::NoPendingClaim));
    }
    let ts = now()?;
    if ts < st.unlock_ts() {
        return Err(err(VaultError::ClaimWindowActive));
    }

    // Effects.
    st.owner = st.pending_owner;
    st.has_owner = 1;
    st.owner_since = ts.to_le_bytes();
    st.clear_pending();
    emit(&[EV_CLAIM_FINALIZED, &st.place_hash, &st.owner]);
    Ok(())
}
