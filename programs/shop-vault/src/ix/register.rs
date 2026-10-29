//! `register_launch` (disc 1, SPEC §5.2). Runs right after pump `create_v2` in the launch tx; the
//! attestor co-signs the whole tx (D2) and the program verifies pump's post-state (D3).

use pinocchio::{
    cpi::{Seed, Signer},
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::{
    consts::*,
    error::{err, VaultError},
    events::{emit, EV_REGISTERED},
    ix::{
        arr, create_or_adopt, field, now, require_attestor_scope, require_len, require_signer, require_system_program,
        require_writable, transfer,
    },
    not_enough_accounts,
    pda::find,
    state::{cast, cast_mut, check_config, Config, VaultState, TAG_VAULT_STATE, VAULT_STATE_LEN, VERSION},
};

/// Data: `[1] place_hash:[u8;32]` (33 bytes).
/// Accounts: `0 launcher (S,W)`, `1 attestor (S)`, `2 config`, `3 vault_state (W)`, `4 vault (W)`,
/// `5 mint`, `6 bonding_curve`, `7 system_program`, `8 instructions_sysvar`.
pub fn register_launch(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    require_len(data, 33)?;
    let [launcher, attestor, config, vault_state, vault, mint, bonding_curve, system_program, ix_sysvar, ..] = accounts
    else {
        return Err(not_enough_accounts());
    };
    let place_hash: [u8; 32] = field(data, 1)?;

    // 1-2. config, pause flag, signers.
    check_config(config, program_id)?;
    {
        let d = config.try_borrow()?;
        // SAFETY: check_config verified the exact length.
        let cfg: &Config = unsafe { cast(&d) };
        if cfg.paused != 0 {
            return Err(err(VaultError::LaunchesPaused));
        }
        require_signer(launcher)?;
        require_writable(launcher)?;
        require_signer(attestor)?;
        if attestor.address().as_array() != &cfg.attestor.current {
            return Err(err(VaultError::AttestorMismatch));
        }
    }
    // 2b. the attestor's signature authorizes this one top-level instruction only.
    require_attestor_scope(ix_sysvar, program_id)?;

    // 3. canonical VaultState, not yet registered.
    let (state_key, state_bump) = find(&[SEED_VAULT_STATE, &place_hash], program_id, VaultError::InvalidVaultState)?;
    if vault_state.address() != &state_key {
        return Err(err(VaultError::InvalidVaultState));
    }
    if vault_state.owned_by(program_id) {
        return Err(err(VaultError::AlreadyRegistered));
    }
    require_writable(vault_state)?;

    // 4. canonical ShopVault: system-owned, zero data, writable.
    let (vault_key, vault_bump) = find(&[SEED_VAULT, &place_hash], program_id, VaultError::InvalidVault)?;
    if vault.address() != &vault_key
        || !vault.is_writable()
        || !vault.owned_by(&SYSTEM_PROGRAM)
        || vault.data_len() != 0
    {
        return Err(err(VaultError::InvalidVault));
    }

    // 5. the real pump bonding curve of `mint`.
    if !bonding_curve.owned_by(&PUMP_PROGRAM) || bonding_curve.data_len() < BONDING_CURVE_MIN_LEN {
        return Err(err(VaultError::InvalidBondingCurve));
    }
    let (curve_key, _) = find(&[SEED_BONDING_CURVE, mint.address().as_ref()], &PUMP_PROGRAM, VaultError::InvalidBondingCurve)?;
    if bonding_curve.address() != &curve_key {
        return Err(err(VaultError::InvalidBondingCurve));
    }
    {
        let data = bonding_curve.try_borrow()?;
        // Fixed-size view of the stable BondingCurve prefix (length checked above).
        let d = arr::<BONDING_CURVE_MIN_LEN>(&data, 0).ok_or_else(|| err(VaultError::InvalidBondingCurve))?;
        if d[0..8] != BONDING_CURVE_DISC {
            return Err(err(VaultError::InvalidBondingCurve));
        }
        // 6. the coin's creator is this place's vault.
        if &d[BC_CREATOR..BC_CREATOR + 32] != vault_key.as_ref() {
            return Err(err(VaultError::CreatorMismatch));
        }
        // 7. plain SOL curve: not complete, no mayhem / cashback / holder rewards.
        let quote = &d[BC_QUOTE_MINT..BC_QUOTE_MINT + 32];
        if d[BC_COMPLETE] != 0
            || d[BC_IS_MAYHEM] != 0
            || d[BC_IS_CASHBACK] != 0
            || d[BC_IS_HOLDER_REWARD] != 0
            || !(quote == [0u8; 32] || quote == NATIVE_MINT.as_ref())
        {
            return Err(err(VaultError::UnsupportedCurve));
        }
        // 8. nobody has traded the curve yet (the dev buy comes after this instruction).
        if d[BC_REAL_QUOTE_RESERVES..BC_REAL_QUOTE_RESERVES + 8] != [0u8; 8] {
            return Err(err(VaultError::CurveNotFresh));
        }
    }

    // 9. real System Program.
    require_system_program(system_program)?;

    // Effects.
    let bump_arr = [state_bump];
    let seeds = [Seed::from(SEED_VAULT_STATE), Seed::from(&place_hash), Seed::from(&bump_arr)];
    create_or_adopt(vault_state, VAULT_STATE_LEN, launcher, program_id, Signer::from(&seeds))?;

    // Keep the vault rent-exempt so pump's first transfer into it can never fail the rent check.
    let m0 = Rent::get()?.try_minimum_balance(0)?;
    let top_up = m0.saturating_sub(vault.lamports());
    if top_up > 0 {
        transfer(launcher, vault, top_up, &[])?;
    }

    let ts = now()?;
    {
        let mut d = vault_state.try_borrow_mut()?;
        // SAFETY: the account was just created with exactly VAULT_STATE_LEN zeroed bytes.
        let st: &mut VaultState = unsafe { cast_mut(&mut d) };
        st.tag = TAG_VAULT_STATE;
        st.version = VERSION;
        st.state_bump = state_bump;
        st.vault_bump = vault_bump;
        st.place_hash = place_hash;
        st.mint = mint.address().to_bytes();
        st.launcher = launcher.address().to_bytes();
        st.created_at = ts.to_le_bytes();
    }
    emit(&[
        EV_REGISTERED,
        &place_hash,
        mint.address().as_ref(),
        launcher.address().as_ref(),
        vault_key.as_ref(),
        state_key.as_ref(),
    ]);
    Ok(())
}
