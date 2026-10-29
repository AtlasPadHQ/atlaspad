//! PDA helpers. Bumps are derived with `find_program_address` at creation, stored, and re-checked with
//! `create_program_address`; they are never taken from instruction data (SPEC §3.5, T4).

use pinocchio::{error::ProgramError, AccountView, Address};

use crate::{
    consts::{SEED_VAULT, SYSTEM_PROGRAM},
    error::{err, VaultError},
};

/// Canonical PDA and bump; `on_fail` if no bump exists (statistically impossible).
#[inline(never)]
pub fn find(seeds: &[&[u8]], program_id: &Address, on_fail: VaultError) -> Result<(Address, u8), ProgramError> {
    Address::try_find_program_address(seeds, program_id).ok_or_else(|| err(on_fail))
}

/// `check_vault` (SPEC §3.5). The address check is mandatory: ownership cannot authenticate a system
/// account.
#[inline(never)]
pub fn check_vault(
    acc: &AccountView,
    place_hash: &[u8; 32],
    vault_bump: u8,
    program_id: &Address,
) -> Result<(), ProgramError> {
    let expected = Address::create_program_address(&[SEED_VAULT, place_hash, &[vault_bump]], program_id)
        .map_err(|_| err(VaultError::InvalidVault))?;
    if acc.address() != &expected
        || !acc.owned_by(&SYSTEM_PROGRAM)
        || acc.data_len() != 0
        || !acc.is_writable()
    {
        return Err(err(VaultError::InvalidVault));
    }
    Ok(())
}
