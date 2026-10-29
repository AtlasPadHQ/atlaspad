//! Constants (SPEC §2). Every byte offset the program reads from foreign accounts lives here.

use pinocchio::Address;

/// System Program.
pub const SYSTEM_PROGRAM: Address = Address::new_from_array([0u8; 32]);
/// SPL Token (the WSOL token program).
pub const SPL_TOKEN_PROGRAM: Address =
    pinocchio::address::address!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// Wrapped SOL mint.
pub const NATIVE_MINT: Address =
    pinocchio::address::address!("So11111111111111111111111111111111111111112");
/// BPF upgradeable loader (owner of our ProgramData account).
pub const BPF_LOADER_UPGRADEABLE: Address =
    pinocchio::address::address!("BPFLoaderUpgradeab1e11111111111111111111111");
/// pump.fun bonding-curve program (same address on mainnet and devnet).
pub const PUMP_PROGRAM: Address =
    pinocchio::address::address!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

/// `sha256("account:BondingCurve")[..8]`.
pub const BONDING_CURVE_DISC: [u8; 8] = [0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60];
/// The program reads only bytes `0..125` of a BondingCurve.
pub const BONDING_CURVE_MIN_LEN: usize = 125;

// BondingCurve offsets (pump IDL 3.2.0).
pub const BC_REAL_QUOTE_RESERVES: usize = 32;
pub const BC_COMPLETE: usize = 48;
pub const BC_CREATOR: usize = 49;
pub const BC_IS_MAYHEM: usize = 81;
pub const BC_IS_CASHBACK: usize = 82;
pub const BC_QUOTE_MINT: usize = 83;
pub const BC_IS_HOLDER_REWARD: usize = 124;

// PDA seeds.
pub const SEED_CONFIG: &[u8] = b"config";
pub const SEED_VAULT: &[u8] = b"vault";
pub const SEED_VAULT_STATE: &[u8] = b"vault_state";
pub const SEED_BONDING_CURVE: &[u8] = b"bonding-curve";

// Build-profile constants (SPEC §2). The default build is mainnet. The devnet MAX window is below the mainnet MIN
// (72 h), so the mainnet runbook's `initialize_config(.., 259_200)` fails on a devnet binary (review finding R2-A3).
#[cfg(not(feature = "devnet"))]
pub const MIN_CLAIM_WINDOW_SECS: i64 = 259_200; // 72 h
#[cfg(feature = "devnet")]
pub const MIN_CLAIM_WINDOW_SECS: i64 = 60;
#[cfg(not(feature = "devnet"))]
pub const MAX_CLAIM_WINDOW_SECS: i64 = 2_592_000; // 30 d
#[cfg(feature = "devnet")]
pub const MAX_CLAIM_WINDOW_SECS: i64 = 86_400; // 24 h
/// Delay before anyone may apply an attestor or guardian proposal without the guardian's consent.
#[cfg(not(feature = "devnet"))]
pub const ROTATION_DELAY_SECS: i64 = 604_800; // 7 d
#[cfg(feature = "devnet")]
pub const ROTATION_DELAY_SECS: i64 = 300;
/// Delay of a proposal made after the guardian vetoed one of the same kind; the guardian cannot veto it.
pub const ESCALATED_ROTATION_DELAY_SECS: i64 = 2 * ROTATION_DELAY_SECS; // 14 d / 600 s
/// After every attestor change, new claims unlock no earlier than `probation_until + window` and the shop's owner
/// may cancel them.
pub const PROBATION_SECS: i64 = ROTATION_DELAY_SECS; // 7 d / 300 s
/// Delay of a governance recovery proposed by the guardian (governance can cancel it at any time).
#[cfg(not(feature = "devnet"))]
pub const GOVERNANCE_RECOVERY_DELAY_SECS: i64 = 2_592_000; // 30 d
#[cfg(feature = "devnet")]
pub const GOVERNANCE_RECOVERY_DELAY_SECS: i64 = 900;
/// A governance proposal can be accepted only in `[eta, eta + window)`.
pub const GOVERNANCE_ACCEPT_WINDOW_SECS: i64 = 2_592_000; // 30 d
/// Per place, governance may cancel this many claims (lifetime); after that only the guardian (or the claimant / the
/// owner in probation) can. The guardian is not limited: governance can replace a hostile guardian, while nothing but
/// governance itself can replace governance.
pub const MAX_GOVERNANCE_SOLO_CANCELS: u8 = 2;
/// Build flavour, stored in Config and in the `ConfigInitialized` event. The marker string is also greppable in the
/// `.so` (scripts/check-artifact.sh).
#[cfg(not(feature = "devnet"))]
pub const FLAVOR: u8 = 0;
#[cfg(feature = "devnet")]
pub const FLAVOR: u8 = 1;
#[cfg(not(feature = "devnet"))]
pub const FLAVOR_MARKER: &[u8] = b"shop-vault-build:mainnet";
#[cfg(feature = "devnet")]
pub const FLAVOR_MARKER: &[u8] = b"shop-vault-build:devnet";

// SPL Token account layout (165 bytes) used by `unwrap_wsol`.
pub const TOKEN_ACCOUNT_LEN: usize = 165;
pub const TA_MINT: usize = 0;
pub const TA_OWNER: usize = 32;
pub const TA_STATE: usize = 108;
pub const TA_IS_NATIVE: usize = 109;
/// SPL Token `CloseAccount` instruction tag.
pub const TOKEN_IX_CLOSE_ACCOUNT: u8 = 9;

// Upgradeable-loader ProgramData header: [3,0,0,0] slot:u64 option:u8 authority:[u8;32].
pub const PROGRAMDATA_HEADER_LEN: usize = 45;

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn bonding_curve_discriminator_is_sha256_of_the_account_name() {
        assert_eq!(Sha256::digest(b"account:BondingCurve")[..8], BONDING_CURVE_DISC);
    }

    #[test]
    fn well_known_ids() {
        assert_eq!(SYSTEM_PROGRAM.to_bytes(), [0u8; 32]);
        assert_eq!(NATIVE_MINT, pinocchio::address::address!("So11111111111111111111111111111111111111112"));
        assert_eq!(crate::ID, pinocchio::address::address!("6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x"));
    }

    #[test]
    fn build_profile_bounds() {
        const { assert!(MIN_CLAIM_WINDOW_SECS <= MAX_CLAIM_WINDOW_SECS) };
        #[cfg(not(feature = "devnet"))]
        assert_eq!((MIN_CLAIM_WINDOW_SECS, MAX_CLAIM_WINDOW_SECS, ROTATION_DELAY_SECS, FLAVOR), (259_200, 2_592_000, 604_800, 0));
        #[cfg(feature = "devnet")]
        assert_eq!((MIN_CLAIM_WINDOW_SECS, MAX_CLAIM_WINDOW_SECS, ROTATION_DELAY_SECS, FLAVOR), (60, 86_400, 300, 1));
        // A devnet binary can never accept the mainnet window.
        #[cfg(feature = "devnet")]
        const { assert!(MAX_CLAIM_WINDOW_SECS < 259_200) };
    }
}
