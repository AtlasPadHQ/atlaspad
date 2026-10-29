//! `withdraw` (disc 5, SPEC §5.6). The only instruction that moves lamports out of a ShopVault or a
//! VaultState, and only to `VaultState.owner`, never below the rent minimum (I1, I2).

use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::{
    consts::SEED_VAULT,
    error::{err, VaultError},
    events::{emit, EV_WITHDRAWN},
    ix::{require_len, require_signer, require_system_program, require_writable, transfer},
    not_enough_accounts,
    pda::check_vault,
    state::{cast, cast_mut, check_state, VaultState, VAULT_STATE_LEN},
};

/// Data: `[5]`. Accounts: `0 owner (S,W)`, `1 vault_state (W)`, `2 vault (W)`, `3 system_program`.
pub fn withdraw(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    require_len(data, 1)?;
    let [owner, vault_state, vault, system_program, ..] = accounts else {
        return Err(not_enough_accounts());
    };

    check_state(vault_state, program_id, true)?;
    let (place_hash, vault_bump, total) = {
        let d = vault_state.try_borrow()?;
        // SAFETY: check_state verified the exact length.
        let st: &VaultState = unsafe { cast(&d) };
        if st.has_owner == 0 {
            return Err(err(VaultError::NoOwner));
        }
        if owner.address().as_array() != &st.owner {
            return Err(err(VaultError::NotOwner));
        }
        (st.place_hash, st.vault_bump, st.total_withdrawn())
    };
    require_signer(owner)?;
    require_writable(owner)?;
    check_vault(vault, &place_hash, vault_bump, program_id)?;
    require_system_program(system_program)?;

    let rent = Rent::get()?;
    let a = vault.lamports().saturating_sub(rent.try_minimum_balance(0)?);
    let b = vault_state.lamports().saturating_sub(rent.try_minimum_balance(VAULT_STATE_LEN)?);
    if a == 0 && b == 0 {
        return Err(err(VaultError::NothingToWithdraw));
    }
    let amount = a.checked_add(b).ok_or_else(|| err(VaultError::ArithmeticOverflow))?;
    let new_total = total.checked_add(amount).ok_or_else(|| err(VaultError::ArithmeticOverflow))?;

    // Effects. No data borrow is held across the CPI.
    if a > 0 {
        let bump_arr = [vault_bump];
        let seeds = [Seed::from(SEED_VAULT), Seed::from(&place_hash), Seed::from(&bump_arr)];
        transfer(vault, owner, a, &[Signer::from(&seeds)])?;
    }
    if b > 0 {
        let from = vault_state.lamports().checked_sub(b).ok_or(ProgramError::InsufficientFunds)?;
        let to = owner.lamports().checked_add(b).ok_or_else(|| err(VaultError::ArithmeticOverflow))?;
        vault_state.set_lamports(from);
        owner.set_lamports(to);
    }
    {
        let mut d = vault_state.try_borrow_mut()?;
        // SAFETY: as above.
        let st: &mut VaultState = unsafe { cast_mut(&mut d) };
        st.total_withdrawn = new_total.to_le_bytes();
    }
    emit(&[EV_WITHDRAWN, &place_hash, owner.address().as_ref(), &amount.to_le_bytes(), &new_total.to_le_bytes()]);
    Ok(())
}
