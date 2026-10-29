//! shop-vault instruction builders and layouts, written independently of the program crate from
//! SPEC.md §3 and §5 (so the tests check the spec, not the implementation against itself).
#![allow(dead_code)]

use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};

pub const PROGRAM_ID: Address = solana_address::address!("6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x");
pub const SYSTEM: Address = Address::new_from_array([0; 32]);
pub const SPL_TOKEN: Address = solana_address::address!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const BPF_UPGRADEABLE: Address = solana_address::address!("BPFLoaderUpgradeab1e11111111111111111111111");

pub const INSTRUCTIONS_SYSVAR: Address = solana_address::address!("Sysvar1nstructions1111111111111111111111111");

pub const CONFIG_LEN: usize = 256;
pub const VAULT_STATE_LEN: usize = 208;
pub const WINDOW_72H: i64 = 259_200;
/// Mainnet build constants (SPEC §2).
pub const ROTATION_DELAY: i64 = 604_800;
pub const ESCALATED_DELAY: i64 = 1_209_600;
pub const PROBATION: i64 = 604_800;
pub const RECOVERY_DELAY: i64 = 2_592_000;
pub const GOVERNANCE_ACCEPT_WINDOW: i64 = 2_592_000;
pub const MAX_GOVERNANCE_SOLO_CANCELS: u8 = 2;
/// Devnet build constants.
pub const DEVNET_MAX_WINDOW: i64 = 86_400;
pub const DEVNET_ROTATION_DELAY: i64 = 300;

/// Error codes (SPEC §6).
pub mod e {
    pub const INVALID_INSTRUCTION: u32 = 100;
    pub const INVALID_CONFIG: u32 = 101;
    pub const INVALID_VAULT_STATE: u32 = 102;
    pub const INVALID_VAULT: u32 = 103;
    pub const NOT_UPGRADE_AUTHORITY: u32 = 104;
    pub const ALREADY_INITIALIZED: u32 = 105;
    pub const INVALID_WINDOW: u32 = 106;
    pub const INVALID_AUTHORITY_KEY: u32 = 107;
    pub const ATTESTOR_MISMATCH: u32 = 108;
    pub const LAUNCHES_PAUSED: u32 = 109;
    pub const ALREADY_REGISTERED: u32 = 110;
    pub const INVALID_ACCOUNT_STATE: u32 = 111;
    pub const INVALID_BONDING_CURVE: u32 = 112;
    pub const CREATOR_MISMATCH: u32 = 113;
    pub const UNSUPPORTED_CURVE: u32 = 114;
    pub const INVALID_SYSTEM_PROGRAM: u32 = 115;
    pub const CURVE_NOT_FRESH: u32 = 116;
    pub const CLAIM_ALREADY_PENDING: u32 = 117;
    pub const NO_PENDING_CLAIM: u32 = 118;
    pub const BAD_NONCE: u32 = 119;
    pub const SAME_OWNER: u32 = 120;
    pub const INVALID_OWNER: u32 = 121;
    pub const CLAIM_WINDOW_ACTIVE: u32 = 122;
    pub const CLAIM_WINDOW_ELAPSED: u32 = 123;
    pub const UNAUTHORIZED: u32 = 124;
    pub const NO_OWNER: u32 = 125;
    pub const NOT_OWNER: u32 = 126;
    pub const NOTHING_TO_WITHDRAW: u32 = 127;
    pub const ARITHMETIC_OVERFLOW: u32 = 128;
    pub const NO_PENDING_ROTATION: u32 = 129;
    pub const ROTATION_NOT_READY: u32 = 130;
    pub const NO_PENDING_GOVERNANCE: u32 = 131;
    pub const INVALID_TOKEN_PROGRAM: u32 = 132;
    pub const INVALID_TOKEN_ACCOUNT: u32 = 133;
    pub const ACCOUNT_NOT_WRITABLE: u32 = 134;
    pub const INVALID_INSTRUCTIONS_SYSVAR: u32 = 135;
    pub const ATTESTOR_SCOPE: u32 = 136;
    pub const GOVERNANCE_CANCEL_LIMIT: u32 = 137;
    pub const PROPOSAL_ESCALATED: u32 = 138;
    pub const PROPOSAL_EXPIRED: u32 = 139;
}

/// ClaimCancelled roles (SPEC §7).
pub mod role {
    pub const GUARDIAN: u8 = 0;
    pub const GOVERNANCE: u8 = 1;
    pub const CLAIMANT: u8 = 2;
    pub const OWNER_IN_PROBATION: u8 = 3;
}

pub fn place_hash(place_id: &str) -> [u8; 32] {
    Sha256::digest(place_id.as_bytes()).into()
}

pub fn config_pda() -> (Address, u8) {
    Address::find_program_address(&[b"config"], &PROGRAM_ID)
}
pub fn vault_pda(ph: &[u8; 32]) -> (Address, u8) {
    Address::find_program_address(&[b"vault", ph], &PROGRAM_ID)
}
pub fn state_pda(ph: &[u8; 32]) -> (Address, u8) {
    Address::find_program_address(&[b"vault_state", ph], &PROGRAM_ID)
}
pub fn programdata_pda() -> Address {
    Address::find_program_address(&[PROGRAM_ID.as_ref()], &BPF_UPGRADEABLE).0
}

fn ro(a: Address) -> AccountMeta {
    AccountMeta::new_readonly(a, false)
}
fn w(a: Address) -> AccountMeta {
    AccountMeta::new(a, false)
}
fn ros(a: Address) -> AccountMeta {
    AccountMeta::new_readonly(a, true)
}
fn ws(a: Address) -> AccountMeta {
    AccountMeta::new(a, true)
}

pub fn ix(accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction { program_id: PROGRAM_ID, accounts, data }
}

pub fn initialize_config(payer: Address, attestor: Address, governance: Address, guardian: Address, window: i64) -> Instruction {
    let mut d = vec![0u8];
    d.extend_from_slice(attestor.as_ref());
    d.extend_from_slice(governance.as_ref());
    d.extend_from_slice(guardian.as_ref());
    d.extend_from_slice(&window.to_le_bytes());
    ix(vec![ws(payer), w(config_pda().0), ro(programdata_pda()), ro(SYSTEM)], d)
}

pub struct RegisterAccounts {
    pub launcher: Address,
    pub attestor: Address,
    pub config: Address,
    pub vault_state: Address,
    pub vault: Address,
    pub mint: Address,
    pub bonding_curve: Address,
    pub system: Address,
    pub instructions: Address,
}

impl RegisterAccounts {
    pub fn new(launcher: Address, attestor: Address, ph: &[u8; 32], mint: Address) -> Self {
        Self {
            launcher,
            attestor,
            config: config_pda().0,
            vault_state: state_pda(ph).0,
            vault: vault_pda(ph).0,
            mint,
            bonding_curve: super::pump::bonding_curve(&mint),
            system: SYSTEM,
            instructions: INSTRUCTIONS_SYSVAR,
        }
    }
}

pub fn register_launch_with(a: &RegisterAccounts, ph: &[u8; 32]) -> Instruction {
    let mut d = vec![1u8];
    d.extend_from_slice(ph);
    ix(
        vec![
            ws(a.launcher),
            ros(a.attestor),
            ro(a.config),
            w(a.vault_state),
            w(a.vault),
            ro(a.mint),
            ro(a.bonding_curve),
            ro(a.system),
            ro(a.instructions),
        ],
        d,
    )
}

pub fn register_launch(launcher: Address, attestor: Address, ph: &[u8; 32], mint: Address) -> Instruction {
    register_launch_with(&RegisterAccounts::new(launcher, attestor, ph, mint), ph)
}

pub fn request_claim(attestor: Address, new_owner: Address, ph: &[u8; 32], nonce: u64) -> Instruction {
    let mut d = vec![2u8];
    d.extend_from_slice(&nonce.to_le_bytes());
    ix(vec![ros(attestor), ros(new_owner), ro(config_pda().0), w(state_pda(ph).0), ro(INSTRUCTIONS_SYSVAR)], d)
}

pub fn cancel_claim(authority: Address, ph: &[u8; 32]) -> Instruction {
    ix(vec![ros(authority), ro(config_pda().0), w(state_pda(ph).0)], vec![3])
}

pub fn finalize_claim(ph: &[u8; 32]) -> Instruction {
    ix(vec![w(state_pda(ph).0)], vec![4])
}

pub fn withdraw(owner: Address, ph: &[u8; 32]) -> Instruction {
    ix(vec![ws(owner), w(state_pda(ph).0), w(vault_pda(ph).0), ro(SYSTEM)], vec![5])
}

pub fn unwrap_wsol(ph: &[u8; 32], wsol_account: Address) -> Instruction {
    ix(vec![ro(state_pda(ph).0), w(vault_pda(ph).0), w(wsol_account), ro(SPL_TOKEN)], vec![6])
}

pub fn set_paused(authority: Address, paused: u8) -> Instruction {
    ix(vec![ros(authority), w(config_pda().0)], vec![7, paused])
}

pub fn propose_attestor(governance: Address, new: Address) -> Instruction {
    let mut d = vec![8u8];
    d.extend_from_slice(new.as_ref());
    ix(vec![ros(governance), w(config_pda().0)], d)
}

pub fn accept_attestor(caller: Address) -> Instruction {
    ix(vec![ros(caller), w(config_pda().0)], vec![9])
}

pub fn cancel_attestor_proposal(authority: Address) -> Instruction {
    ix(vec![ros(authority), w(config_pda().0)], vec![10])
}

pub fn propose_governance(governance: Address, new: Address) -> Instruction {
    let mut d = vec![11u8];
    d.extend_from_slice(new.as_ref());
    ix(vec![ros(governance), w(config_pda().0)], d)
}

pub fn accept_governance(new_governance: Address) -> Instruction {
    ix(vec![ros(new_governance), w(config_pda().0)], vec![12])
}

pub fn propose_guardian(governance: Address, new: Address) -> Instruction {
    let mut d = vec![13u8];
    d.extend_from_slice(new.as_ref());
    ix(vec![ros(governance), w(config_pda().0)], d)
}

pub fn accept_guardian(caller: Address) -> Instruction {
    ix(vec![ros(caller), w(config_pda().0)], vec![14])
}

pub fn cancel_guardian_proposal(authority: Address) -> Instruction {
    ix(vec![ros(authority), w(config_pda().0)], vec![15])
}

/// Decoded Config (SPEC §3.2), by fixed offsets.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigView {
    pub tag: u8,
    pub version: u8,
    pub bump: u8,
    pub paused: u8,
    pub flavor: u8,
    pub flags: u8,
    pub attestor: Address,
    pub pending_attestor: Address,
    pub pending_attestor_eta: i64,
    pub guardian: Address,
    pub pending_guardian: Address,
    pub pending_guardian_eta: i64,
    pub governance: Address,
    pub pending_governance: Address,
    pub pending_governance_eta: i64,
    pub claim_window_secs: i64,
    pub probation_until: i64,
    pub rotation_delay_secs: i64,
    pub raw: Vec<u8>,
}

fn key_at(d: &[u8], off: usize) -> Address {
    Address::new_from_array(d[off..off + 32].try_into().unwrap())
}
fn i64_at(d: &[u8], off: usize) -> i64 {
    i64::from_le_bytes(d[off..off + 8].try_into().unwrap())
}
fn u64_at(d: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(d[off..off + 8].try_into().unwrap())
}

/// Config `flags` bits.
pub const FLAG_ATTESTOR_VETOED: u8 = 1;
pub const FLAG_GUARDIAN_VETOED: u8 = 2;
pub const FLAG_GOVERNANCE_BY_GUARDIAN: u8 = 4;

impl ConfigView {
    pub fn decode(d: &[u8]) -> Self {
        assert_eq!(d.len(), CONFIG_LEN);
        assert_eq!(&d[6..8], &[0u8; 2], "pad0");
        assert_eq!(&d[248..256], &[0u8; 8], "reserved");
        assert!(d[4] <= 1 && d[5] <= 7);
        Self {
            tag: d[0],
            version: d[1],
            bump: d[2],
            paused: d[3],
            flavor: d[4],
            flags: d[5],
            attestor: key_at(d, 8),
            pending_attestor: key_at(d, 40),
            pending_attestor_eta: i64_at(d, 72),
            guardian: key_at(d, 80),
            pending_guardian: key_at(d, 112),
            pending_guardian_eta: i64_at(d, 144),
            governance: key_at(d, 152),
            pending_governance: key_at(d, 184),
            pending_governance_eta: i64_at(d, 216),
            claim_window_secs: i64_at(d, 224),
            probation_until: i64_at(d, 232),
            rotation_delay_secs: i64_at(d, 240),
            raw: d.to_vec(),
        }
    }
}

/// Decoded VaultState (SPEC §3.3), by fixed offsets.
#[derive(Debug, Clone, PartialEq)]
pub struct StateView {
    pub tag: u8,
    pub version: u8,
    pub state_bump: u8,
    pub vault_bump: u8,
    pub has_owner: bool,
    pub has_pending: bool,
    pub governance_cancels: u8,
    /// bit 0: the pending claim was requested during a probation (the owner may cancel it).
    pub pending_flags: u8,
    pub place_hash: [u8; 32],
    pub mint: Address,
    pub launcher: Address,
    pub owner: Address,
    pub pending_owner: Address,
    pub unlock_ts: i64,
    pub claim_nonce: u64,
    pub total_withdrawn: u64,
    pub created_at: i64,
    pub owner_since: i64,
}

impl StateView {
    pub fn decode(d: &[u8]) -> Self {
        assert_eq!(d.len(), VAULT_STATE_LEN);
        assert!(d[4] <= 1 && d[5] <= 1 && d[7] <= 1);
        assert!(d[6] <= MAX_GOVERNANCE_SOLO_CANCELS);
        assert!(d[5] == 1 || d[7] == 0, "pending flags only with a pending claim");
        Self {
            tag: d[0],
            version: d[1],
            state_bump: d[2],
            vault_bump: d[3],
            has_owner: d[4] == 1,
            has_pending: d[5] == 1,
            governance_cancels: d[6],
            pending_flags: d[7],
            place_hash: d[8..40].try_into().unwrap(),
            mint: key_at(d, 40),
            launcher: key_at(d, 72),
            owner: key_at(d, 104),
            pending_owner: key_at(d, 136),
            unlock_ts: i64_at(d, 168),
            claim_nonce: u64_at(d, 176),
            total_withdrawn: u64_at(d, 184),
            created_at: i64_at(d, 192),
            owner_since: i64_at(d, 200),
        }
    }
}
