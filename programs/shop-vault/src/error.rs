//! Custom error codes (SPEC §6). They start at 100 so they never collide with System Program CPI errors.

use pinocchio::error::ProgramError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum VaultError {
    InvalidInstruction = 100,
    InvalidConfig = 101,
    InvalidVaultState = 102,
    InvalidVault = 103,
    NotUpgradeAuthority = 104,
    AlreadyInitialized = 105,
    InvalidWindow = 106,
    InvalidAuthorityKey = 107,
    AttestorMismatch = 108,
    LaunchesPaused = 109,
    AlreadyRegistered = 110,
    InvalidAccountState = 111,
    InvalidBondingCurve = 112,
    CreatorMismatch = 113,
    UnsupportedCurve = 114,
    InvalidSystemProgram = 115,
    CurveNotFresh = 116,
    ClaimAlreadyPending = 117,
    NoPendingClaim = 118,
    BadNonce = 119,
    SameOwner = 120,
    InvalidOwner = 121,
    ClaimWindowActive = 122,
    ClaimWindowElapsed = 123,
    Unauthorized = 124,
    NoOwner = 125,
    NotOwner = 126,
    NothingToWithdraw = 127,
    ArithmeticOverflow = 128,
    NoPendingRotation = 129,
    RotationNotReady = 130,
    NoPendingGovernance = 131,
    InvalidTokenProgram = 132,
    InvalidTokenAccount = 133,
    AccountNotWritable = 134,
    /// The account passed as the Instructions sysvar is not `Sysvar1nstructions1111111111111111111111111`.
    InvalidInstructionsSysvar = 135,
    /// An attestor-co-signed instruction must be top level and the only shop_vault instruction in its transaction.
    AttestorScope = 136,
    /// Governance has used its MAX_GOVERNANCE_SOLO_CANCELS cancels at this place; only the guardian can cancel now.
    GovernanceCancelLimit = 137,
    /// The guardian cannot veto a proposal made after its previous veto of the same kind.
    ProposalEscalated = 138,
    /// The governance proposal's acceptance window has passed.
    ProposalExpired = 139,
}

impl From<VaultError> for ProgramError {
    #[inline(always)]
    fn from(e: VaultError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

/// Shorthand: `Err(err(VaultError::X))`.
#[inline(always)]
pub fn err(e: VaultError) -> ProgramError {
    ProgramError::Custom(e as u32)
}

#[cfg(test)]
mod tests {
    use super::VaultError::*;

    /// The codes are part of the client ABI (SPEC §6): 100..=139 in table order.
    #[test]
    fn codes_match_spec_table() {
        let all = [
            InvalidInstruction, InvalidConfig, InvalidVaultState, InvalidVault, NotUpgradeAuthority,
            AlreadyInitialized, InvalidWindow, InvalidAuthorityKey, AttestorMismatch, LaunchesPaused,
            AlreadyRegistered, InvalidAccountState, InvalidBondingCurve, CreatorMismatch, UnsupportedCurve,
            InvalidSystemProgram, CurveNotFresh, ClaimAlreadyPending, NoPendingClaim, BadNonce, SameOwner,
            InvalidOwner, ClaimWindowActive, ClaimWindowElapsed, Unauthorized, NoOwner, NotOwner,
            NothingToWithdraw, ArithmeticOverflow, NoPendingRotation, RotationNotReady, NoPendingGovernance,
            InvalidTokenProgram, InvalidTokenAccount, AccountNotWritable, InvalidInstructionsSysvar, AttestorScope,
            GovernanceCancelLimit, ProposalEscalated, ProposalExpired,
        ];
        for (i, e) in all.iter().enumerate() {
            assert_eq!(*e as u32, 100 + i as u32);
            assert_eq!(super::err(*e), pinocchio::error::ProgramError::Custom(100 + i as u32));
        }
    }
}
