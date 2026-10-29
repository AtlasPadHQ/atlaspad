//! Account layouts (SPEC §3.2, §3.3). Every struct is `#[repr(C)]` over byte arrays only, so it has
//! alignment 1, no padding, and fixed offsets (asserted below). Integers are little-endian.

use core::mem::{offset_of, size_of};

use pinocchio::{error::ProgramError, AccountView, Address};

use crate::error::{err, VaultError};

pub const TAG_CONFIG: u8 = 1;
pub const TAG_VAULT_STATE: u8 = 2;
pub const VERSION: u8 = 1;

pub const CONFIG_LEN: usize = 256;
pub const VAULT_STATE_LEN: usize = 208;

pub const ZERO_KEY: [u8; 32] = [0u8; 32];

/// Config `flags` bits.
/// The guardian vetoed an attestor proposal; the next ones are escalated (longer delay, no guardian veto) until one is
/// applied.
pub const FLAG_ATTESTOR_VETOED: u8 = 1;
/// The same for guardian proposals.
pub const FLAG_GUARDIAN_VETOED: u8 = 2;
/// The pending governance proposal is a recovery proposed by the guardian (it has a delay).
pub const FLAG_GOVERNANCE_BY_GUARDIAN: u8 = 4;

/// VaultState `pending_flags` bit: the pending claim was requested during a probation, so the owner may cancel it.
pub const PENDING_IN_PROBATION: u8 = 1;

/// An attestor or guardian key with its pending replacement (SPEC §3.2). The two share one rotation code path.
#[repr(C)]
pub struct Rotation {
    pub current: [u8; 32],
    /// Zero = no proposal.
    pub pending: [u8; 32],
    /// i64 unix secs from which anyone may apply `pending`; 0 = none.
    pub eta: [u8; 8],
}

/// `["config"]` (SPEC §3.2).
#[repr(C)]
pub struct Config {
    pub tag: u8,
    pub version: u8,
    pub bump: u8,
    pub paused: u8,
    /// 0 mainnet build, 1 devnet build (`consts::FLAVOR`).
    pub flavor: u8,
    /// `FLAG_*` bits.
    pub flags: u8,
    pub _pad0: [u8; 2],
    /// Online key that co-signs `register_launch` and `request_claim`, and nothing else.
    pub attestor: Rotation,
    /// Offline ops key: pause, cancel claims (bounded), veto or consent to attestor/guardian rotations.
    pub guardian: Rotation,
    pub governance: [u8; 32],
    pub pending_governance: [u8; 32],
    /// i64: a governance proposal can be accepted in `[eta, eta + GOVERNANCE_ACCEPT_WINDOW_SECS)`.
    pub pending_governance_eta: [u8; 8],
    pub claim_window_secs: [u8; 8],
    /// i64: claims requested before this time are in probation (set by every attestor change).
    pub probation_until: [u8; 8],
    /// `consts::ROTATION_DELAY_SECS` of the build that initialised this Config (informational).
    pub rotation_delay_secs: [u8; 8],
    pub _reserved: [u8; 8],
}

const _: () = assert!(size_of::<Rotation>() == 72);
const _: () = assert!(size_of::<Config>() == CONFIG_LEN);
const _: () = assert!(core::mem::align_of::<Config>() == 1);
const _: () = assert!(offset_of!(Config, paused) == 3);
const _: () = assert!(offset_of!(Config, flavor) == 4);
const _: () = assert!(offset_of!(Config, flags) == 5);
const _: () = assert!(offset_of!(Config, attestor) == 8);
const _: () = assert!(offset_of!(Config, guardian) == 80);
const _: () = assert!(offset_of!(Config, governance) == 152);
const _: () = assert!(offset_of!(Config, pending_governance) == 184);
const _: () = assert!(offset_of!(Config, pending_governance_eta) == 216);
const _: () = assert!(offset_of!(Config, claim_window_secs) == 224);
const _: () = assert!(offset_of!(Config, probation_until) == 232);
const _: () = assert!(offset_of!(Config, rotation_delay_secs) == 240);
const _: () = assert!(offset_of!(Config, _reserved) == 248);

impl Config {
    #[inline(always)]
    pub fn claim_window(&self) -> i64 {
        i64::from_le_bytes(self.claim_window_secs)
    }
    #[inline(always)]
    pub fn probation_until(&self) -> i64 {
        i64::from_le_bytes(self.probation_until)
    }
}

/// `["vault_state", place_hash]` (SPEC §3.3).
#[repr(C)]
pub struct VaultState {
    pub tag: u8,
    pub version: u8,
    pub state_bump: u8,
    pub vault_bump: u8,
    pub has_owner: u8,
    pub has_pending: u8,
    /// Claims cancelled by governance at this place, ever (at most MAX_GOVERNANCE_SOLO_CANCELS).
    pub governance_cancels: u8,
    /// `PENDING_*` bits of the pending claim.
    pub pending_flags: u8,
    pub place_hash: [u8; 32],
    pub mint: [u8; 32],
    pub launcher: [u8; 32],
    pub owner: [u8; 32],
    pub pending_owner: [u8; 32],
    pub unlock_ts: [u8; 8],
    pub claim_nonce: [u8; 8],
    pub total_withdrawn: [u8; 8],
    pub created_at: [u8; 8],
    pub owner_since: [u8; 8],
}

const _: () = assert!(size_of::<VaultState>() == VAULT_STATE_LEN);
const _: () = assert!(core::mem::align_of::<VaultState>() == 1);
const _: () = assert!(offset_of!(VaultState, has_owner) == 4);
const _: () = assert!(offset_of!(VaultState, has_pending) == 5);
const _: () = assert!(offset_of!(VaultState, governance_cancels) == 6);
const _: () = assert!(offset_of!(VaultState, pending_flags) == 7);
const _: () = assert!(offset_of!(VaultState, place_hash) == 8);
const _: () = assert!(offset_of!(VaultState, mint) == 40);
const _: () = assert!(offset_of!(VaultState, launcher) == 72);
const _: () = assert!(offset_of!(VaultState, owner) == 104);
const _: () = assert!(offset_of!(VaultState, pending_owner) == 136);
const _: () = assert!(offset_of!(VaultState, unlock_ts) == 168);
const _: () = assert!(offset_of!(VaultState, claim_nonce) == 176);
const _: () = assert!(offset_of!(VaultState, total_withdrawn) == 184);
const _: () = assert!(offset_of!(VaultState, created_at) == 192);
const _: () = assert!(offset_of!(VaultState, owner_since) == 200);

impl VaultState {
    #[inline(always)]
    pub fn unlock_ts(&self) -> i64 {
        i64::from_le_bytes(self.unlock_ts)
    }
    #[inline(always)]
    pub fn claim_nonce(&self) -> u64 {
        u64::from_le_bytes(self.claim_nonce)
    }
    #[inline(always)]
    pub fn total_withdrawn(&self) -> u64 {
        u64::from_le_bytes(self.total_withdrawn)
    }
    #[inline(always)]
    pub fn clear_pending(&mut self) {
        self.has_pending = 0;
        self.pending_flags = 0;
        self.pending_owner = ZERO_KEY;
        self.unlock_ts = [0u8; 8];
    }
}

/// Reinterprets account bytes as a layout struct. The caller has checked the exact length.
///
/// # Safety
/// `data.len() == size_of::<T>()` and `T` is `#[repr(C)]` over byte arrays (alignment 1).
#[inline(always)]
pub unsafe fn cast<T>(data: &[u8]) -> &T {
    &*(data.as_ptr() as *const T)
}

/// # Safety
/// As [`cast`].
#[inline(always)]
pub unsafe fn cast_mut<T>(data: &mut [u8]) -> &mut T {
    &mut *(data.as_mut_ptr() as *mut T)
}

/// `load_config` (SPEC §3.5): program-owned, exact length, tag and version.
#[inline(never)]
pub fn check_config(acc: &AccountView, program_id: &Address) -> Result<(), ProgramError> {
    if !acc.owned_by(program_id) || acc.data_len() != CONFIG_LEN {
        return Err(err(VaultError::InvalidConfig));
    }
    let data = acc.try_borrow()?;
    if data.get(0..2) != Some(&[TAG_CONFIG, VERSION][..]) {
        return Err(err(VaultError::InvalidConfig));
    }
    Ok(())
}

/// `load_state` (SPEC §3.5): program-owned, exact length, tag, version and, when asked, writable.
#[inline(never)]
pub fn check_state(acc: &AccountView, program_id: &Address, writable: bool) -> Result<(), ProgramError> {
    if !acc.owned_by(program_id) || acc.data_len() != VAULT_STATE_LEN || (writable && !acc.is_writable()) {
        return Err(err(VaultError::InvalidVaultState));
    }
    let data = acc.try_borrow()?;
    if data.get(0..2) != Some(&[TAG_VAULT_STATE, VERSION][..]) {
        return Err(err(VaultError::InvalidVaultState));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_round_trip_through_byte_offsets() {
        let mut d = [0u8; VAULT_STATE_LEN];
        {
            // SAFETY: exact length, alignment 1.
            let st: &mut VaultState = unsafe { cast_mut(&mut d) };
            st.tag = TAG_VAULT_STATE;
            st.owner = [7u8; 32];
            st.unlock_ts = (-5i64).to_le_bytes();
            st.claim_nonce = 9u64.to_le_bytes();
            st.owner_since = 11i64.to_le_bytes();
        }
        assert_eq!(d[0], 2);
        assert_eq!(&d[104..136], &[7u8; 32]);
        assert_eq!(i64::from_le_bytes(d[168..176].try_into().unwrap()), -5);
        assert_eq!(u64::from_le_bytes(d[176..184].try_into().unwrap()), 9);
        assert_eq!(i64::from_le_bytes(d[200..208].try_into().unwrap()), 11);
        let st: &VaultState = unsafe { cast(&d) };
        assert_eq!((st.unlock_ts(), st.claim_nonce()), (-5, 9));

        let mut c = [0u8; CONFIG_LEN];
        {
            let cfg: &mut Config = unsafe { cast_mut(&mut c) };
            cfg.claim_window_secs = 259_200i64.to_le_bytes();
            cfg.attestor.eta = 42i64.to_le_bytes();
            cfg.guardian.pending = [5u8; 32];
            cfg.governance = [3u8; 32];
        }
        assert_eq!(i64::from_le_bytes(c[224..232].try_into().unwrap()), 259_200);
        assert_eq!(i64::from_le_bytes(c[72..80].try_into().unwrap()), 42);
        assert_eq!(&c[112..144], &[5u8; 32]);
        assert_eq!(&c[152..184], &[3u8; 32]);
    }

    #[test]
    fn clear_pending_zeroes_the_pending_fields_only() {
        let mut d = [0xffu8; VAULT_STATE_LEN];
        let st: &mut VaultState = unsafe { cast_mut(&mut d) };
        st.clear_pending();
        assert_eq!((st.has_pending, st.pending_flags, st.pending_owner, st.unlock_ts), (0, 0, ZERO_KEY, [0u8; 8]));
        assert_eq!((st.owner, st.governance_cancels), ([0xffu8; 32], 0xff));
        assert_eq!(st.claim_nonce(), u64::MAX);
    }
}
