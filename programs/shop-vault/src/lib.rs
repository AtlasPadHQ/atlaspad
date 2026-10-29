//! CORNERSHOP shop-vault (SPEC.md v1).
//!
//! Every Google place gets one pump.fun coin whose `creator` is a per-place, system-owned vault PDA
//! `["vault", place_hash]`. Only the phone-verified owner recorded in `["vault_state", place_hash]`
//! can take SOL out of that vault, and only after a public claim window. There is no admin
//! withdrawal path.
#![no_std]

pub mod consts;
pub mod error;
pub mod events;
pub mod ix;
pub mod pda;
pub mod state;

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::error::{err, VaultError};

pinocchio::address::declare_id!("6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x");

/// Instruction discriminators (SPEC §5, byte 0 of the instruction data).
pub mod disc {
    pub const INITIALIZE_CONFIG: u8 = 0;
    pub const REGISTER_LAUNCH: u8 = 1;
    pub const REQUEST_CLAIM: u8 = 2;
    pub const CANCEL_CLAIM: u8 = 3;
    pub const FINALIZE_CLAIM: u8 = 4;
    pub const WITHDRAW: u8 = 5;
    pub const UNWRAP_WSOL: u8 = 6;
    pub const SET_PAUSED: u8 = 7;
    pub const PROPOSE_ATTESTOR: u8 = 8;
    pub const ACCEPT_ATTESTOR: u8 = 9;
    pub const CANCEL_ATTESTOR_PROPOSAL: u8 = 10;
    pub const PROPOSE_GOVERNANCE: u8 = 11;
    pub const ACCEPT_GOVERNANCE: u8 = 12;
    pub const PROPOSE_GUARDIAN: u8 = 13;
    pub const ACCEPT_GUARDIAN: u8 = 14;
    pub const CANCEL_GUARDIAN_PROPOSAL: u8 = 15;
}

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    // No instruction takes more than 9 accounts; extra trailing accounts are skipped (SPEC §5).
    pinocchio::program_entrypoint!(crate::process_instruction, 9);
    pinocchio::no_allocator!();
    pinocchio::nostd_panic_handler!();
}

pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    let Some((&tag, _)) = data.split_first() else {
        return Err(err(VaultError::InvalidInstruction));
    };
    match tag {
        disc::INITIALIZE_CONFIG => ix::init::initialize_config(program_id, accounts, data),
        disc::REGISTER_LAUNCH => ix::register::register_launch(program_id, accounts, data),
        disc::REQUEST_CLAIM => ix::claim::request_claim(program_id, accounts, data),
        disc::CANCEL_CLAIM => ix::claim::cancel_claim(program_id, accounts, data),
        disc::FINALIZE_CLAIM => ix::claim::finalize_claim(program_id, accounts, data),
        disc::WITHDRAW => ix::withdraw::withdraw(program_id, accounts, data),
        disc::UNWRAP_WSOL => ix::unwrap::unwrap_wsol(program_id, accounts, data),
        disc::SET_PAUSED..=disc::CANCEL_GUARDIAN_PROPOSAL => ix::admin::admin(program_id, accounts, data),
        _ => Err(err(VaultError::InvalidInstruction)),
    }
}

/// `Err(NotEnoughAccountKeys)` helper for slice patterns.
#[inline(always)]
pub(crate) fn not_enough_accounts() -> ProgramError {
    ProgramError::NotEnoughAccountKeys
}
