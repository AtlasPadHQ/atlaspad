//! Admin instructions (discs 7-15, SPEC §5.8). They only touch Config: none of them can read or write a
//! VaultState or move lamports (I8).
//!
//! Roles: the **guardian** (an offline ops key, never the online attestor) pauses, vetoes rotations and consents to
//! them; **governance** (a Squads vault) proposes rotations. An attestor or guardian proposal applies at once with
//! the guardian's consent, or by anyone after its delay. A guardian veto makes the next proposal of that kind
//! *escalated*: a longer delay and no veto, so neither key can block the other forever. Every attestor change starts
//! a probation that slows new claims (see `request_claim`).

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::{
    consts::{
        ESCALATED_ROTATION_DELAY_SECS, GOVERNANCE_ACCEPT_WINDOW_SECS, GOVERNANCE_RECOVERY_DELAY_SECS, PROBATION_SECS,
        ROTATION_DELAY_SECS,
    },
    disc,
    error::{err, VaultError},
    events::*,
    ix::{arr, now, require_signer, require_writable},
    not_enough_accounts,
    state::{
        cast_mut, check_config, Config, FLAG_ATTESTOR_VETOED, FLAG_GOVERNANCE_BY_GUARDIAN, FLAG_GUARDIAN_VETOED,
        ZERO_KEY,
    },
};

#[inline(always)]
fn add(a: i64, b: i64) -> Result<i64, ProgramError> {
    a.checked_add(b).ok_or_else(|| err(VaultError::ArithmeticOverflow))
}

/// Discs 7-15. Data: `[d]`, `[7] paused:u8`, or `[8 | 11 | 13] new:[u8;32]`.
/// Accounts: `0 authority (S)`, `1 config (W)`.
pub fn admin(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let Some((&d, args)) = data.split_first() else {
        return Err(err(VaultError::InvalidInstruction));
    };
    let want = match d {
        disc::SET_PAUSED => 1,
        disc::PROPOSE_ATTESTOR | disc::PROPOSE_GOVERNANCE | disc::PROPOSE_GUARDIAN => 32,
        _ => 0,
    };
    if args.len() != want {
        return Err(err(VaultError::InvalidInstruction));
    }
    let [authority, config, ..] = accounts else {
        return Err(not_enough_accounts());
    };
    check_config(config, program_id)?;
    require_writable(config)?;
    require_signer(authority)?;
    let who = authority.address().to_bytes();
    let mut cfg_d = config.try_borrow_mut()?;
    // SAFETY: check_config verified the exact length.
    let cfg: &mut Config = unsafe { cast_mut(&mut cfg_d) };
    let ts = now()?;
    let new = arr::<32>(args, 0).copied().unwrap_or(ZERO_KEY);
    match d {
        disc::SET_PAUSED => set_paused(cfg, &who, args.first().copied().unwrap_or(2)),
        disc::PROPOSE_GOVERNANCE => propose_governance(cfg, &who, new, ts),
        disc::ACCEPT_GOVERNANCE => accept_governance(cfg, &who, ts),
        // 8, 9, 10 rotate the attestor; 13, 14, 15 the guardian.
        _ => {
            let guardian_slot = d >= disc::PROPOSE_GUARDIAN;
            match d - if guardian_slot { disc::PROPOSE_GUARDIAN } else { disc::PROPOSE_ATTESTOR } {
                0 => propose_rotation(cfg, &who, new, guardian_slot, ts),
                1 => accept_rotation(cfg, &who, guardian_slot, ts),
                _ => cancel_rotation(cfg, &who, guardian_slot),
            }
        }
    }
}

/// `[7] paused:u8`. authority ∈ {guardian, governance}.
#[inline(never)]
fn set_paused(cfg: &mut Config, who: &[u8; 32], paused: u8) -> ProgramResult {
    if who != &cfg.guardian.current && who != &cfg.governance {
        return Err(err(VaultError::Unauthorized));
    }
    if paused > 1 {
        return Err(err(VaultError::InvalidInstruction));
    }
    cfg.paused = paused;
    emit(&[EV_ADMIN_CHANGED, &[ADMIN_PAUSED], &[paused], who]);
    Ok(())
}

/// The veto flag and the AdminChanged kind base (proposed = base, applied = base + 1, cancelled = base + 2).
#[inline(always)]
fn slot_consts(guardian_slot: bool) -> (u8, u8) {
    if guardian_slot {
        (FLAG_GUARDIAN_VETOED, ADMIN_GUARDIAN_PROPOSED)
    } else {
        (FLAG_ATTESTOR_VETOED, ADMIN_ATTESTOR_PROPOSED)
    }
}

/// `propose_attestor` (8) / `propose_guardian` (13), governance only. The delay is ROTATION_DELAY_SECS, or
/// ESCALATED_ROTATION_DELAY_SECS after a guardian veto of the same kind. Overwrites an earlier proposal.
#[inline(never)]
fn propose_rotation(cfg: &mut Config, who: &[u8; 32], new: [u8; 32], guardian_slot: bool, ts: i64) -> ProgramResult {
    if who != &cfg.governance {
        return Err(err(VaultError::Unauthorized));
    }
    let (veto, kind) = slot_consts(guardian_slot);
    let (slot, other) =
        if guardian_slot { (&mut cfg.guardian, &cfg.attestor) } else { (&mut cfg.attestor, &cfg.guardian) };
    // The three keys stay distinct.
    if new == ZERO_KEY || new == cfg.governance || new == other.current {
        return Err(err(VaultError::InvalidAuthorityKey));
    }
    let escalated = cfg.flags & veto != 0;
    slot.pending = new;
    slot.eta = add(ts, if escalated { ESCALATED_ROTATION_DELAY_SECS } else { ROTATION_DELAY_SECS })?.to_le_bytes();
    emit(&[EV_ADMIN_CHANGED, &[kind], &new, &slot.eta, &[escalated as u8]]);
    Ok(())
}

/// `accept_attestor` (9) / `accept_guardian` (14). The guardian applies the proposal at once (consent); anyone
/// else only after its eta. Every attestor change starts a probation of PROBATION_SECS.
#[inline(never)]
fn accept_rotation(cfg: &mut Config, who: &[u8; 32], guardian_slot: bool, ts: i64) -> ProgramResult {
    let (veto, kind) = slot_consts(guardian_slot);
    let consent = who == &cfg.guardian.current;
    let (slot, other) =
        if guardian_slot { (&mut cfg.guardian, &cfg.attestor) } else { (&mut cfg.attestor, &cfg.guardian) };
    if slot.pending == ZERO_KEY {
        return Err(err(VaultError::NoPendingRotation));
    }
    if !consent && ts < i64::from_le_bytes(slot.eta) {
        return Err(err(VaultError::RotationNotReady));
    }
    // The other keys may have changed since the proposal.
    if slot.pending == cfg.governance || slot.pending == other.current {
        return Err(err(VaultError::InvalidAuthorityKey));
    }
    slot.current = slot.pending;
    slot.pending = ZERO_KEY;
    slot.eta = [0u8; 8];
    cfg.flags &= !veto;
    if !guardian_slot {
        cfg.probation_until = add(ts, PROBATION_SECS)?.max(i64::from_le_bytes(cfg.probation_until)).to_le_bytes();
    }
    emit(&[EV_ADMIN_CHANGED, &[kind + 1], &slot.current, &cfg.probation_until, &[consent as u8]]);
    Ok(())
}

/// `cancel_attestor_proposal` (10) / `cancel_guardian_proposal` (15). Governance withdraws its proposal; the
/// guardian vetoes it unless it is escalated. A veto makes the next proposal of this kind escalated.
#[inline(never)]
fn cancel_rotation(cfg: &mut Config, who: &[u8; 32], guardian_slot: bool) -> ProgramResult {
    let (veto, kind) = slot_consts(guardian_slot);
    let role = if who == &cfg.governance {
        ROLE_GOVERNANCE
    } else if who == &cfg.guardian.current {
        ROLE_GUARDIAN
    } else {
        return Err(err(VaultError::Unauthorized));
    };
    let slot = if guardian_slot { &mut cfg.guardian } else { &mut cfg.attestor };
    if slot.pending == ZERO_KEY {
        return Err(err(VaultError::NoPendingRotation));
    }
    if role == ROLE_GUARDIAN {
        if cfg.flags & veto != 0 {
            return Err(err(VaultError::ProposalEscalated));
        }
        cfg.flags |= veto;
    }
    emit(&[EV_ADMIN_CHANGED, &[kind + 2], &slot.pending, &[role]]);
    slot.pending = ZERO_KEY;
    slot.eta = [0u8; 8];
    Ok(())
}

/// `[11] new:[u8;32]`.
/// - governance: hand governance over to `new` (it must accept within GOVERNANCE_ACCEPT_WINDOW_SECS), or withdraw any
///   pending governance proposal with the zero key;
/// - guardian: recovery for a lost governance key; `new` may accept after GOVERNANCE_RECOVERY_DELAY_SECS unless
///   governance withdraws or replaces it first. The zero key withdraws the guardian's own proposal.
#[inline(never)]
fn propose_governance(cfg: &mut Config, who: &[u8; 32], new: [u8; 32], ts: i64) -> ProgramResult {
    let by_guardian = if who == &cfg.governance {
        false
    } else if who == &cfg.guardian.current {
        true
    } else {
        return Err(err(VaultError::Unauthorized));
    };
    let role = by_guardian as u8 ^ 1; // ROLE_GUARDIAN = 0, ROLE_GOVERNANCE = 1
    if new == ZERO_KEY {
        if cfg.pending_governance == ZERO_KEY {
            return Err(err(VaultError::NoPendingGovernance));
        }
        if by_guardian && cfg.flags & FLAG_GOVERNANCE_BY_GUARDIAN == 0 {
            return Err(err(VaultError::Unauthorized));
        }
        emit(&[EV_ADMIN_CHANGED, &[ADMIN_GOVERNANCE_PROPOSAL_CANCELLED], &cfg.pending_governance, &[role]]);
        cfg.pending_governance = ZERO_KEY;
        cfg.pending_governance_eta = [0u8; 8];
        cfg.flags &= !FLAG_GOVERNANCE_BY_GUARDIAN;
        return Ok(());
    }
    if new == cfg.attestor.current || new == cfg.guardian.current || new == cfg.governance {
        return Err(err(VaultError::InvalidAuthorityKey));
    }
    cfg.pending_governance = new;
    cfg.pending_governance_eta = add(ts, if by_guardian { GOVERNANCE_RECOVERY_DELAY_SECS } else { 0 })?.to_le_bytes();
    cfg.flags = (cfg.flags & !FLAG_GOVERNANCE_BY_GUARDIAN) | if by_guardian { FLAG_GOVERNANCE_BY_GUARDIAN } else { 0 };
    emit(&[EV_ADMIN_CHANGED, &[ADMIN_GOVERNANCE_PROPOSED], &new, &cfg.pending_governance_eta, &[role]]);
    Ok(())
}

/// `[12]`, signed by the pending governance key in `[eta, eta + GOVERNANCE_ACCEPT_WINDOW_SECS)`. A governance change
/// clears every pending attestor and guardian proposal and every veto flag, so nothing a previous (possibly
/// compromised) governance proposed survives the handover.
#[inline(never)]
fn accept_governance(cfg: &mut Config, who: &[u8; 32], ts: i64) -> ProgramResult {
    if cfg.pending_governance == ZERO_KEY {
        return Err(err(VaultError::NoPendingGovernance));
    }
    if who != &cfg.pending_governance || who == &cfg.attestor.current || who == &cfg.guardian.current {
        return Err(err(VaultError::Unauthorized));
    }
    let eta = i64::from_le_bytes(cfg.pending_governance_eta);
    if ts < eta {
        return Err(err(VaultError::RotationNotReady));
    }
    if ts >= add(eta, GOVERNANCE_ACCEPT_WINDOW_SECS)? {
        return Err(err(VaultError::ProposalExpired));
    }
    emit(&[
        EV_ADMIN_CHANGED,
        &[ADMIN_GOVERNANCE_APPLIED],
        who,
        &cfg.attestor.pending,
        &cfg.guardian.pending,
        &[cfg.flags & FLAG_GOVERNANCE_BY_GUARDIAN],
    ]);
    cfg.governance = *who;
    cfg.pending_governance = ZERO_KEY;
    cfg.pending_governance_eta = [0u8; 8];
    for slot in [&mut cfg.attestor, &mut cfg.guardian] {
        slot.pending = ZERO_KEY;
        slot.eta = [0u8; 8];
    }
    cfg.flags = 0;
    Ok(())
}
