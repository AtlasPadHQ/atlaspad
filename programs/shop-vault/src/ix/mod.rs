pub mod admin;
pub mod claim;
pub mod init;
pub mod register;
pub mod unwrap;
pub mod withdraw;

use pinocchio::{
    cpi::Signer,
    error::ProgramError,
    sysvars::{
        clock::Clock,
        instructions::{Instructions, INSTRUCTIONS_ID},
        Sysvar,
    },
    AccountView, Address, ProgramResult,
};

use pinocchio_system::instructions::Transfer;

use crate::{
    consts::SYSTEM_PROGRAM,
    error::{err, VaultError},
};

/// `create_or_adopt` (SPEC §5.1). The caller has already rejected a program-owned account with its
/// own error (`AlreadyInitialized` / `AlreadyRegistered`). A PDA pre-funded by a griefer is adopted
/// (top up, `Allocate`, `Assign`) instead of failing `CreateAccount` with `AccountAlreadyInUse`.
#[inline(never)]
pub(crate) fn create_or_adopt(
    acc: &mut AccountView,
    len: usize,
    payer: &AccountView,
    program_id: &Address,
    signer: Signer,
) -> ProgramResult {
    if !acc.owned_by(&SYSTEM_PROGRAM) || acc.data_len() != 0 {
        return Err(err(VaultError::InvalidAccountState));
    }
    pinocchio_system::create_account_with_minimum_balance_signed(acc, len, program_id, payer, None, &[signer])
}

/// Binds the attestor's co-signature to one instruction (SPEC §5.2/§5.3, review finding R1 "co-signed launch carries
/// other attestor powers"): the instruction being executed must be at the top level of the transaction (not a CPI)
/// and no other top-level instruction may invoke this program. The attestor signs whole transactions, so without
/// this a co-signed launch or claim could carry a second attestor-gated instruction (a claim for another place).
#[inline(never)]
pub(crate) fn require_attestor_scope(ix_sysvar: &AccountView, program_id: &Address) -> ProgramResult {
    if ix_sysvar.address() != &INSTRUCTIONS_ID {
        return Err(err(VaultError::InvalidInstructionsSysvar));
    }
    // SAFETY: the address check above proves this is the runtime-provided Instructions sysvar.
    let ixs = unsafe { Instructions::new_unchecked(ix_sysvar.try_borrow()?) };
    let current = ixs.load_current_index() as usize;
    for i in 0..ixs.num_instructions() {
        let ours = ixs.load_instruction_at(i)?.get_program_id() == program_id;
        if ours != (i == current) {
            return Err(err(VaultError::AttestorScope));
        }
    }
    Ok(())
}

#[inline(never)]
pub(crate) fn now() -> Result<i64, ProgramError> {
    Ok(Clock::get()?.unix_timestamp)
}

#[inline(always)]
pub(crate) fn require_signer(acc: &AccountView) -> ProgramResult {
    if !acc.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

#[inline(always)]
pub(crate) fn require_writable(acc: &AccountView) -> ProgramResult {
    if !acc.is_writable() {
        return Err(err(VaultError::AccountNotWritable));
    }
    Ok(())
}

#[inline(always)]
pub(crate) fn require_system_program(acc: &AccountView) -> ProgramResult {
    if acc.address() != &SYSTEM_PROGRAM {
        return Err(err(VaultError::InvalidSystemProgram));
    }
    Ok(())
}

#[inline(always)]
pub(crate) fn require_len(data: &[u8], len: usize) -> ProgramResult {
    if data.len() != len {
        return Err(err(VaultError::InvalidInstruction));
    }
    Ok(())
}

/// `N` bytes at `off`, without a panic path (no slice indexing; keeps core::fmt out of the binary).
#[inline(always)]
pub(crate) fn arr<const N: usize>(d: &[u8], off: usize) -> Option<&[u8; N]> {
    d.get(off..off.checked_add(N)?).and_then(|s| s.try_into().ok())
}

/// Instruction-data field: `N` bytes at `off` (the caller already checked the exact data length).
#[inline(always)]
pub(crate) fn field<const N: usize>(data: &[u8], off: usize) -> Result<[u8; N], ProgramError> {
    arr::<N>(data, off).copied().ok_or_else(|| err(VaultError::InvalidInstruction))
}

/// `System::Transfer` (one shared copy of the CPI code). `signer` signs for a PDA `from`.
#[inline(never)]
pub(crate) fn transfer(from: &AccountView, to: &AccountView, lamports: u64, signer: &[Signer]) -> ProgramResult {
    Transfer { from, to, lamports }.invoke_signed(signer)
}
