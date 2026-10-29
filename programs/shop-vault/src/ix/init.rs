//! `initialize_config` (disc 0, SPEC §5.0).

use pinocchio::{
    cpi::{Seed, Signer},
    AccountView, Address, ProgramResult,
};

use crate::{
    consts::{
        BPF_LOADER_UPGRADEABLE, FLAVOR, FLAVOR_MARKER, MAX_CLAIM_WINDOW_SECS, MIN_CLAIM_WINDOW_SECS, PROGRAMDATA_HEADER_LEN,
        ROTATION_DELAY_SECS, SEED_CONFIG,
    },
    error::{err, VaultError},
    events::{emit, EV_CONFIG_INITIALIZED},
    ix::{arr, create_or_adopt, field, require_len, require_signer, require_system_program, require_writable},
    not_enough_accounts,
    pda::find,
    state::{cast_mut, Config, CONFIG_LEN, TAG_CONFIG, VERSION, ZERO_KEY},
};

/// Data: `[0] attestor:[u8;32] governance:[u8;32] guardian:[u8;32] claim_window_secs:i64` (105 bytes).
/// Accounts: `0 payer (S,W) = upgrade authority`, `1 config (W)`, `2 program_data`, `3 system_program`.
pub fn initialize_config(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    require_len(data, 105)?;
    let [payer, config, program_data, system_program, ..] = accounts else {
        return Err(not_enough_accounts());
    };
    let attestor: [u8; 32] = field(data, 1)?;
    let governance: [u8; 32] = field(data, 33)?;
    let guardian: [u8; 32] = field(data, 65)?;
    let window = i64::from_le_bytes(field(data, 97)?);

    // 1. payer signs and is writable.
    require_signer(payer)?;
    require_writable(payer)?;

    // 2. payer is the program's upgrade authority (blocks a front-run init right after deploy).
    let (pd, _) = find(&[program_id.as_ref()], &BPF_LOADER_UPGRADEABLE, VaultError::NotUpgradeAuthority)?;
    if program_data.address() != &pd
        || !program_data.owned_by(&BPF_LOADER_UPGRADEABLE)
        || program_data.data_len() < PROGRAMDATA_HEADER_LEN
    {
        return Err(err(VaultError::NotUpgradeAuthority));
    }
    {
        let d = program_data.try_borrow()?;
        let header = arr::<PROGRAMDATA_HEADER_LEN>(&d, 0).ok_or_else(|| err(VaultError::NotUpgradeAuthority))?;
        if header[0..4] != [3, 0, 0, 0] || header[12] != 1 || &header[13..45] != payer.address().as_ref() {
            return Err(err(VaultError::NotUpgradeAuthority));
        }
    }

    // 3. canonical config address, not yet initialized.
    let (cfg_key, bump) = find(&[SEED_CONFIG], program_id, VaultError::InvalidConfig)?;
    if config.address() != &cfg_key {
        return Err(err(VaultError::InvalidConfig));
    }
    if config.owned_by(program_id) {
        return Err(err(VaultError::AlreadyInitialized));
    }
    require_writable(config)?;

    // 4. three non-zero, pairwise distinct authority keys.
    if attestor == ZERO_KEY
        || governance == ZERO_KEY
        || guardian == ZERO_KEY
        || attestor == governance
        || attestor == guardian
        || governance == guardian
    {
        return Err(err(VaultError::InvalidAuthorityKey));
    }

    // 5. claim window bounds (compile-time per build profile).
    if !(MIN_CLAIM_WINDOW_SECS..=MAX_CLAIM_WINDOW_SECS).contains(&window) {
        return Err(err(VaultError::InvalidWindow));
    }

    // 6. real System Program.
    require_system_program(system_program)?;

    // Effects.
    let bump_arr = [bump];
    let seeds = [Seed::from(SEED_CONFIG), Seed::from(&bump_arr)];
    create_or_adopt(config, CONFIG_LEN, payer, program_id, Signer::from(&seeds))?;
    {
        let mut d = config.try_borrow_mut()?;
        // SAFETY: the account was just created with exactly CONFIG_LEN bytes.
        let cfg: &mut Config = unsafe { cast_mut(&mut d) };
        cfg.tag = TAG_CONFIG;
        cfg.version = VERSION;
        cfg.bump = bump;
        cfg.paused = 0;
        cfg.flavor = FLAVOR;
        cfg.attestor.current = attestor;
        cfg.governance = governance;
        cfg.guardian.current = guardian;
        cfg.claim_window_secs = window.to_le_bytes();
        cfg.rotation_delay_secs = ROTATION_DELAY_SECS.to_le_bytes();
        // flags, pending fields, probation and padding: zero from CreateAccount/Allocate.
    }
    emit(&[
        EV_CONFIG_INITIALIZED,
        &attestor,
        &governance,
        &guardian,
        &window.to_le_bytes(),
        FLAVOR_MARKER,
        &ROTATION_DELAY_SECS.to_le_bytes(),
    ]);
    Ok(())
}
