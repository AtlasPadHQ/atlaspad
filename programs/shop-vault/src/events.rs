//! Events (SPEC §7) via `sol_log_data`: segment 0 is the ASCII event name, then one segment per field
//! (raw 32-byte keys, little-endian integers). Account state is authoritative; events are hints.

pub const EV_CONFIG_INITIALIZED: &[u8] = b"ConfigInitialized";
pub const EV_REGISTERED: &[u8] = b"Registered";
pub const EV_CLAIM_REQUESTED: &[u8] = b"ClaimRequested";
pub const EV_CLAIM_CANCELLED: &[u8] = b"ClaimCancelled";
pub const EV_CLAIM_FINALIZED: &[u8] = b"ClaimFinalized";
pub const EV_WITHDRAWN: &[u8] = b"Withdrawn";
pub const EV_UNWRAPPED: &[u8] = b"Unwrapped";
pub const EV_ADMIN_CHANGED: &[u8] = b"AdminChanged";

// AdminChanged kinds (SPEC §7).
pub const ADMIN_PAUSED: u8 = 0;
pub const ADMIN_ATTESTOR_PROPOSED: u8 = 1;
pub const ADMIN_ATTESTOR_APPLIED: u8 = 2;
pub const ADMIN_ATTESTOR_PROPOSAL_CANCELLED: u8 = 3;
pub const ADMIN_GOVERNANCE_PROPOSED: u8 = 4;
pub const ADMIN_GOVERNANCE_APPLIED: u8 = 5;
pub const ADMIN_GUARDIAN_PROPOSED: u8 = 6;
pub const ADMIN_GUARDIAN_APPLIED: u8 = 7;
pub const ADMIN_GUARDIAN_PROPOSAL_CANCELLED: u8 = 8;
pub const ADMIN_GOVERNANCE_PROPOSAL_CANCELLED: u8 = 9;

// Roles in AdminChanged / ClaimCancelled events.
pub const ROLE_GUARDIAN: u8 = 0;
pub const ROLE_GOVERNANCE: u8 = 1;
pub const ROLE_CLAIMANT: u8 = 2;
pub const ROLE_OWNER_IN_PROBATION: u8 = 3;

#[inline(always)]
pub fn emit(segments: &[&[u8]]) {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    // SAFETY: `&[u8]` is a (ptr, len) pair with the same layout as the syscall's `SolBytes`.
    unsafe {
        pinocchio::syscalls::sol_log_data(segments.as_ptr() as *const u8, segments.len() as u64);
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    let _ = segments;
}
