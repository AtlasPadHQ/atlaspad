//! CLM-*: request / cancel / finalize with the 72 h window of the mainnet build (SPEC §5.3-§5.5, §13.3).
#![allow(clippy::result_large_err, deprecated)]
mod common;

use common::*;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;

const PLACE: &str = "ChIJN1t_tDeuEmsRUsoyG83frY4";

/// Sends, expects failure, asserts the VaultState and Config bytes are unchanged.
#[track_caller]
fn fails_no_change(env: &mut Env, ph: &[u8; 32], ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) -> TxResult {
    let keys = [sv::state_pda(ph).0, sv::config_pda().0, sv::vault_pda(ph).0];
    let before = env.snapshot(&keys);
    let r = env.send(ixs, payer, extra);
    assert!(r.is_err(), "expected failure");
    assert_eq!(env.snapshot(&keys), before, "failed claim tx changed state");
    r
}

fn setup() -> (Env, Launched) {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    (env, l)
}

#[test]
fn clm01_request_sets_pending_and_unlock() {
    let (mut env, l) = setup();
    let owner = env.funded(1);
    let now = env.now();
    let m = ok(env.request_claim(&l.ph, &owner, 1));
    let st = env.state(&l.ph);
    assert!(st.has_pending && !st.has_owner);
    assert_eq!(st.pending_owner, owner.pubkey());
    assert_eq!(st.unlock_ts, now + WINDOW_72H);
    assert_eq!(st.claim_nonce, 1);
    let ev = program_events(&m, "ClaimRequested");
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0][1], l.ph.to_vec());
    assert_eq!(ev[0][2], owner.pubkey().as_ref().to_vec());
    assert_eq!(ev[0][3], 1u64.to_le_bytes().to_vec());
    assert_eq!(ev[0][4], (now + WINDOW_72H).to_le_bytes().to_vec());
    let cu = shop_vault_cu(&m)[0];
    println!("request_claim CU {cu}");
    assert!(cu <= 4_000, "request_claim CU {cu}");
}

#[test]
fn clm02_attestor_missing_or_wrong_or_owner_not_signing() {
    let (mut env, l) = setup();
    let owner = env.funded(1);
    let attestor = env.attestor.insecure_clone();
    // Attestor not signing.
    let mut ix = sv::request_claim(attestor.pubkey(), owner.pubkey(), &l.ph, 1);
    ix.accounts[0].is_signer = false;
    let r = fails_no_change(&mut env, &l.ph, &[ix], &owner, &[]);
    expect_ix(&r, InstructionError::MissingRequiredSignature);
    // Wrong attestor.
    let fake = Keypair::new();
    let r = fails_no_change(&mut env, &l.ph, &[sv::request_claim(fake.pubkey(), owner.pubkey(), &l.ph, 1)], &owner, &[&fake]);
    expect_custom(&r, e::ATTESTOR_MISMATCH);
    // The governance key is not an attestor either.
    let gov = env.governance.insecure_clone();
    let r = fails_no_change(&mut env, &l.ph, &[sv::request_claim(gov.pubkey(), owner.pubkey(), &l.ph, 1)], &owner, &[&gov]);
    expect_custom(&r, e::ATTESTOR_MISMATCH);
    // New owner not signing (a relayer pays).
    let mut ix = sv::request_claim(attestor.pubkey(), owner.pubkey(), &l.ph, 1);
    ix.accounts[1].is_signer = false;
    let cranker = env.cranker.insecure_clone();
    let r = fails_no_change(&mut env, &l.ph, &[ix], &cranker, &[&attestor]);
    expect_ix(&r, InstructionError::MissingRequiredSignature);
    // With a relayer as fee payer and both signatures it works.
    ok(env.send(&[sv::request_claim(attestor.pubkey(), owner.pubkey(), &l.ph, 1)], &cranker, &[&attestor, &owner]));
}

#[test]
fn clm03_nonce_must_be_last_plus_one_and_is_consumed_by_cancel() {
    let (mut env, l) = setup();
    let owner = env.funded(1);
    let attestor = env.attestor.insecure_clone();
    for bad in [0u64, 2, u64::MAX] {
        let r = fails_no_change(&mut env, &l.ph, &[sv::request_claim(attestor.pubkey(), owner.pubkey(), &l.ph, bad)], &owner, &[&attestor]);
        expect_custom(&r, e::BAD_NONCE);
    }
    ok(env.request_claim(&l.ph, &owner, 1));
    let grd = env.guardian.insecure_clone();
    ok(env.send(&[sv::cancel_claim(grd.pubkey(), &l.ph)], &owner, &[&grd]));
    let st = env.state(&l.ph);
    assert!(!st.has_pending);
    assert_eq!(st.claim_nonce, 1, "nonce stays consumed after a cancel");
    let r = fails_no_change(&mut env, &l.ph, &[sv::request_claim(attestor.pubkey(), owner.pubkey(), &l.ph, 1)], &owner, &[&attestor]);
    expect_custom(&r, e::BAD_NONCE);
    ok(env.request_claim(&l.ph, &owner, 2));
    assert_eq!(env.state(&l.ph).claim_nonce, 2);
}

#[test]
fn clm04_request_while_pending() {
    let (mut env, l) = setup();
    let a = env.funded(1);
    let b = env.funded(1);
    ok(env.request_claim(&l.ph, &a, 1));
    let attestor = env.attestor.insecure_clone();
    let r = fails_no_change(&mut env, &l.ph, &[sv::request_claim(attestor.pubkey(), b.pubkey(), &l.ph, 2)], &b, &[&attestor]);
    expect_custom(&r, e::CLAIM_ALREADY_PENDING);
}

#[test]
fn clm05_same_owner_or_authority_as_owner() {
    let (mut env, l) = setup();
    let attestor = env.attestor.insecure_clone();
    let gov = env.governance.insecure_clone();
    env.fund(&gov.pubkey(), LAMPORTS_PER_SOL);
    env.fund(&attestor.pubkey(), LAMPORTS_PER_SOL);
    // attestor or governance as the new owner.
    let r = fails_no_change(&mut env, &l.ph, &[sv::request_claim(attestor.pubkey(), attestor.pubkey(), &l.ph, 1)], &attestor, &[]);
    expect_custom(&r, e::INVALID_OWNER);
    let r = fails_no_change(&mut env, &l.ph, &[sv::request_claim(attestor.pubkey(), gov.pubkey(), &l.ph, 1)], &gov, &[&attestor]);
    expect_custom(&r, e::INVALID_OWNER);
    let grd = env.guardian.insecure_clone();
    env.fund(&grd.pubkey(), LAMPORTS_PER_SOL);
    let r = fails_no_change(&mut env, &l.ph, &[sv::request_claim(attestor.pubkey(), grd.pubkey(), &l.ph, 1)], &grd, &[&attestor]);
    expect_custom(&r, e::INVALID_OWNER);
    // Same owner again after a finalized claim.
    let owner = env.claim_and_finalize(&l.ph);
    let r = fails_no_change(&mut env, &l.ph, &[sv::request_claim(attestor.pubkey(), owner.pubkey(), &l.ph, 2)], &owner, &[&attestor]);
    expect_custom(&r, e::SAME_OWNER);
}

#[test]
fn clm06_finalize_respects_the_window_boundary() {
    let (mut env, l) = setup();
    let owner = env.funded(1);
    ok(env.request_claim(&l.ph, &owner, 1));
    let unlock = env.state(&l.ph).unlock_ts;
    let cranker = env.cranker.insecure_clone();
    // Immediately, one hour later, and at unlock - 1.
    let r = fails_no_change(&mut env, &l.ph, &[sv::finalize_claim(&l.ph)], &cranker, &[]);
    expect_custom(&r, e::CLAIM_WINDOW_ACTIVE);
    env.warp(3600);
    let r = fails_no_change(&mut env, &l.ph, &[sv::finalize_claim(&l.ph)], &cranker, &[]);
    expect_custom(&r, e::CLAIM_WINDOW_ACTIVE);
    env.set_time(unlock - 1);
    let r = fails_no_change(&mut env, &l.ph, &[sv::finalize_claim(&l.ph)], &cranker, &[]);
    expect_custom(&r, e::CLAIM_WINDOW_ACTIVE);
    // Withdraw is impossible before finalization: no owner yet.
    let r = fails_no_change(&mut env, &l.ph, &[sv::withdraw(owner.pubkey(), &l.ph)], &owner, &[]);
    expect_custom(&r, e::NO_OWNER);
    env.set_time(unlock);
    let m = ok(env.send(&[sv::finalize_claim(&l.ph)], &cranker, &[]));
    let st = env.state(&l.ph);
    assert!(st.has_owner && !st.has_pending);
    assert_eq!(st.owner, owner.pubkey());
    assert_eq!(st.owner_since, unlock);
    assert_eq!((st.pending_owner, st.unlock_ts), (Address::default(), 0));
    let ev = program_events(&m, "ClaimFinalized");
    assert_eq!(ev[0][2], owner.pubkey().as_ref().to_vec());
    let cu = shop_vault_cu(&m)[0];
    assert!(cu <= 4_000, "finalize CU {cu}");
}

#[test]
fn clm07_who_may_cancel() {
    // Allowed: guardian (role 0), governance (role 1), the claimant (role 2).
    for role in [role::GUARDIAN, role::GOVERNANCE, role::CLAIMANT] {
        let (mut env, l) = setup();
        let claimant = env.funded(1);
        ok(env.request_claim(&l.ph, &claimant, 1));
        let who = match role {
            role::GUARDIAN => env.guardian.insecure_clone(),
            role::GOVERNANCE => env.governance.insecure_clone(),
            _ => claimant.insecure_clone(),
        };
        let cranker = env.cranker.insecure_clone();
        let m = ok(env.send(&[sv::cancel_claim(who.pubkey(), &l.ph)], &cranker, &[&who]));
        let st = env.state(&l.ph);
        assert!(!st.has_pending);
        assert_eq!((st.pending_owner, st.unlock_ts, st.claim_nonce), (Address::default(), 0, 1));
        assert_eq!(st.governance_cancels, (role == role::GOVERNANCE) as u8, "only governance cancels are counted");
        let ev = program_events(&m, "ClaimCancelled");
        assert_eq!(ev[0][2], who.pubkey().as_ref().to_vec());
        assert_eq!(ev[0][3], vec![role]);
        assert!(shop_vault_cu(&m)[0] <= 4_000);
    }
    // Refused: the attestor (no admin power, review finding R1), the current owner outside a probation (D6) and a
    // stranger; and anyone at unlock.
    let (mut env, l) = setup();
    let owner = env.claim_and_finalize(&l.ph);
    let b = env.funded(1);
    ok(env.request_claim(&l.ph, &b, 2));
    assert_eq!(env.state(&l.ph).pending_flags, 0);
    let r = fails_no_change(&mut env, &l.ph, &[sv::cancel_claim(owner.pubkey(), &l.ph)], &owner, &[]);
    expect_custom(&r, e::UNAUTHORIZED);
    let attestor = env.attestor.insecure_clone();
    let stranger = env.funded(1);
    let r = fails_no_change(&mut env, &l.ph, &[sv::cancel_claim(attestor.pubkey(), &l.ph)], &stranger, &[&attestor]);
    expect_custom(&r, e::UNAUTHORIZED);
    let r = fails_no_change(&mut env, &l.ph, &[sv::cancel_claim(stranger.pubkey(), &l.ph)], &stranger, &[]);
    expect_custom(&r, e::UNAUTHORIZED);
    // Not a signer.
    let mut ix = sv::cancel_claim(env.guardian.pubkey(), &l.ph);
    ix.accounts[0].is_signer = false;
    let r = fails_no_change(&mut env, &l.ph, &[ix], &stranger, &[]);
    expect_ix(&r, InstructionError::MissingRequiredSignature);
    let unlock = env.state(&l.ph).unlock_ts;
    env.set_time(unlock);
    let grd = env.guardian.insecure_clone();
    let r = fails_no_change(&mut env, &l.ph, &[sv::cancel_claim(grd.pubkey(), &l.ph)], &stranger, &[&grd]);
    expect_custom(&r, e::CLAIM_WINDOW_ELAPSED);
}

/// Review finding R1 (bounded cancel power): governance may cancel at most MAX_GOVERNANCE_SOLO_CANCELS claims per
/// place, ever, so a hostile or lost-quorum governance cannot freeze a shop forever, even after `--final`. The
/// guardian is not limited (governance can replace a hostile guardian); claimants always can withdraw their own.
#[test]
fn clm07b_governance_cancel_budget() {
    let (mut env, l) = setup();
    let (grd, gov) = (env.guardian.insecure_clone(), env.governance.insecure_clone());
    let cranker = env.cranker.insecure_clone();
    let other = env.launch("clm07b-other-place", 0);
    let mut nonce = 0;
    let mut open = |env: &mut Env| {
        nonce += 1;
        let c = env.funded(1);
        ok(env.request_claim(&l.ph, &c, nonce));
        c
    };
    for _ in 0..sv::MAX_GOVERNANCE_SOLO_CANCELS {
        open(&mut env);
        ok(env.send(&[sv::cancel_claim(gov.pubkey(), &l.ph)], &cranker, &[&gov]));
    }
    assert_eq!(env.state(&l.ph).governance_cancels, sv::MAX_GOVERNANCE_SOLO_CANCELS);
    open(&mut env);
    let r = fails_no_change(&mut env, &l.ph, &[sv::cancel_claim(gov.pubkey(), &l.ph)], &cranker, &[&gov]);
    expect_custom(&r, e::GOVERNANCE_CANCEL_LIMIT);
    // The guardian still can, as often as needed; so can a claimant (its own claim).
    for _ in 0..3 {
        ok(env.send(&[sv::cancel_claim(grd.pubkey(), &l.ph)], &cranker, &[&grd]));
        let c = open(&mut env);
        ok(env.send(&[sv::cancel_claim(c.pubkey(), &l.ph)], &cranker, &[&c]));
        open(&mut env);
    }
    assert_eq!(env.state(&l.ph).governance_cancels, sv::MAX_GOVERNANCE_SOLO_CANCELS);
    // The budget is per place.
    let x = env.funded(1);
    ok(env.request_claim(&other.ph, &x, 1));
    ok(env.send(&[sv::cancel_claim(gov.pubkey(), &other.ph)], &cranker, &[&gov]));
    // With its budget spent, governance alone can no longer stop a claim at this place: it finalizes.
    let pending = env.state(&l.ph).pending_owner;
    let unlock = env.state(&l.ph).unlock_ts;
    env.set_time(unlock);
    ok(env.send(&[sv::finalize_claim(&l.ph)], &cranker, &[]));
    assert_eq!(env.state(&l.ph).owner, pending);
}

/// Review finding R2-A1: every attestor change starts a probation. A claim requested during it unlocks no earlier than
/// `probation_until + window`, and the shop's current owner may cancel it (role 3). Outside a probation the owner
/// cannot (D6).
#[test]
fn clm14_probation_after_an_attestor_change() {
    let (mut env, l) = setup();
    let owner = env.claim_and_finalize(&l.ph);
    let (grd, gov) = (env.guardian.insecure_clone(), env.governance.insecure_clone());
    let cranker = env.cranker.insecure_clone();
    let new_att = Keypair::new();
    let t0 = env.now();
    ok(env.send(&[sv::propose_attestor(gov.pubkey(), new_att.pubkey()), sv::accept_attestor(grd.pubkey())], &cranker, &[&gov, &grd]));
    env.attestor = new_att;
    let pu = env.config().probation_until;
    assert_eq!(pu, t0 + sv::PROBATION);
    // During probation: delayed unlock, flagged, the owner may cancel.
    env.warp(3_600);
    let b = env.funded(1);
    ok(env.request_claim(&l.ph, &b, 2));
    let st = env.state(&l.ph);
    assert_eq!((st.unlock_ts, st.pending_flags), (pu + WINDOW_72H, 1));
    env.set_time(pu + WINDOW_72H - 1);
    let r = fails_no_change(&mut env, &l.ph, &[sv::finalize_claim(&l.ph)], &cranker, &[]);
    expect_custom(&r, e::CLAIM_WINDOW_ACTIVE);
    let m = ok(env.send(&[sv::cancel_claim(owner.pubkey(), &l.ph)], &cranker, &[&owner]));
    assert_eq!(program_events(&m, "ClaimCancelled")[0][3], vec![role::OWNER_IN_PROBATION]);
    assert_eq!(env.state(&l.ph).governance_cancels, 0, "owner cancels are not counted");
    // After probation: normal window, no flag, the owner can no longer cancel; a stranger never can.
    let c = env.funded(1);
    let t1 = env.now();
    assert!(t1 >= pu);
    ok(env.request_claim(&l.ph, &c, 3));
    let st = env.state(&l.ph);
    assert_eq!((st.unlock_ts, st.pending_flags), (t1 + WINDOW_72H, 0));
    let r = fails_no_change(&mut env, &l.ph, &[sv::cancel_claim(owner.pubkey(), &l.ph)], &cranker, &[&owner]);
    expect_custom(&r, e::UNAUTHORIZED);
    // A claim requested during probation keeps its flag and late unlock after the probation ends.
    ok(env.send(&[sv::cancel_claim(c.pubkey(), &l.ph)], &cranker, &[&c]));
    let t2 = env.now();
    let newer = Keypair::new();
    ok(env.send(&[sv::propose_attestor(gov.pubkey(), newer.pubkey()), sv::accept_attestor(grd.pubkey())], &cranker, &[&gov, &grd]));
    env.attestor = newer;
    let pu2 = env.config().probation_until;
    assert_eq!(pu2, t2 + sv::PROBATION);
    let d = env.funded(1);
    ok(env.request_claim(&l.ph, &d, 4));
    env.set_time(pu2 + 1);
    assert_eq!(env.state(&l.ph).pending_flags, 1);
    ok(env.send(&[sv::cancel_claim(owner.pubkey(), &l.ph)], &cranker, &[&owner]));
    // A claim with no current owner cannot be cancelled through the owner role.
    let fresh = env.launch("clm14-unclaimed", 0);
    let z = env.funded(1);
    let newest = Keypair::new();
    ok(env.send(&[sv::propose_attestor(gov.pubkey(), newest.pubkey()), sv::accept_attestor(grd.pubkey())], &cranker, &[&gov, &grd]));
    env.attestor = newest;
    ok(env.request_claim(&fresh.ph, &z, 1));
    let r = fails_no_change(&mut env, &fresh.ph, &[sv::cancel_claim(owner.pubkey(), &fresh.ph)], &cranker, &[&owner]);
    expect_custom(&r, e::UNAUTHORIZED);
}

/// Review finding R1 (attestor co-signature scope): a request_claim must be the only top-level shop-vault
/// instruction of its tx, and the real Instructions sysvar must be passed.
#[test]
fn clm15_request_claim_is_bound_to_its_own_tx() {
    let mut env = Env::initialized();
    let x = env.launch("clm15-x", 0);
    let y = env.launch("clm15-y", 0);
    let attestor = env.attestor.insecure_clone();
    let owner = env.funded(1);
    let thief = env.funded(1);
    let cranker = env.cranker.insecure_clone();
    // Two claims under one attestor signature (a policy slip in the Worker): refused.
    let ixs = [
        sv::request_claim(attestor.pubkey(), owner.pubkey(), &x.ph, 1),
        sv::request_claim(attestor.pubkey(), thief.pubkey(), &y.ph, 1),
    ];
    let r = fails_no_change(&mut env, &y.ph, &ixs, &cranker, &[&attestor, &owner, &thief]);
    expect_custom_at(&r, 0, e::ATTESTOR_SCOPE);
    assert!(!env.state(&x.ph).has_pending);
    // A claim plus any other shop-vault instruction (here one that succeeds on its own), before or after it: refused.
    let grd = env.guardian.insecure_clone();
    for first in [true, false] {
        let rc = sv::request_claim(attestor.pubkey(), owner.pubkey(), &x.ph, 1);
        let other = sv::set_paused(grd.pubkey(), 0);
        let (ixs, at) = if first { (vec![rc, other], 0) } else { (vec![other, rc], 1) };
        let r = fails_no_change(&mut env, &x.ph, &ixs, &cranker, &[&attestor, &owner, &grd]);
        expect_custom_at(&r, at, e::ATTESTOR_SCOPE);
    }
    // Other programs around it are fine (compute budget, a transfer).
    ok(env.send(
        &[cu_limit(50_000), sv::request_claim(attestor.pubkey(), owner.pubkey(), &x.ph, 1), system_transfer(cranker.pubkey(), owner.pubkey(), 1)],
        &cranker,
        &[&attestor, &owner],
    ));
    // A fake Instructions sysvar.
    let mut ix = sv::request_claim(attestor.pubkey(), thief.pubkey(), &y.ph, 1);
    ix.accounts[4].pubkey = Address::new_unique();
    let r = fails_no_change(&mut env, &y.ph, &[ix], &thief, &[&attestor]);
    expect_custom(&r, e::INVALID_INSTRUCTIONS_SYSVAR);
}

#[test]
fn clm08_nothing_pending() {
    let (mut env, l) = setup();
    let cranker = env.cranker.insecure_clone();
    let grd = env.guardian.insecure_clone();
    let r = fails_no_change(&mut env, &l.ph, &[sv::finalize_claim(&l.ph)], &cranker, &[]);
    expect_custom(&r, e::NO_PENDING_CLAIM);
    let r = fails_no_change(&mut env, &l.ph, &[sv::cancel_claim(grd.pubkey(), &l.ph)], &cranker, &[&grd]);
    expect_custom(&r, e::NO_PENDING_CLAIM);
}

#[test]
fn clm09_reclaim_of_owned_shop() {
    let (mut env, l) = setup();
    let a = env.claim_and_finalize(&l.ph);
    let b = env.funded(1);
    ok(env.request_claim(&l.ph, &b, 2));
    // Fees arrive; A (still the owner) withdraws during B's window.
    let donor = env.funded(3);
    ok(env.send(&[system_transfer(donor.pubkey(), l.vault, LAMPORTS_PER_SOL)], &donor, &[]));
    let before = env.lamports(&a.pubkey());
    let cranker = env.cranker.insecure_clone();
    ok(env.send(&[sv::withdraw(a.pubkey(), &l.ph)], &cranker, &[&a]));
    assert_eq!(env.lamports(&a.pubkey()) - before, LAMPORTS_PER_SOL);
    // B cannot withdraw yet.
    let r = fails_no_change(&mut env, &l.ph, &[sv::withdraw(b.pubkey(), &l.ph)], &cranker, &[&b]);
    expect_custom(&r, e::NOT_OWNER);
    let unlock = env.state(&l.ph).unlock_ts;
    env.set_time(unlock);
    ok(env.send(&[sv::finalize_claim(&l.ph)], &cranker, &[]));
    assert_eq!(env.state(&l.ph).owner, b.pubkey());
    ok(env.send(&[system_transfer(donor.pubkey(), l.vault, LAMPORTS_PER_SOL)], &donor, &[]));
    let r = fails_no_change(&mut env, &l.ph, &[sv::withdraw(a.pubkey(), &l.ph)], &cranker, &[&a]);
    expect_custom(&r, e::NOT_OWNER);
    let before = env.lamports(&b.pubkey());
    ok(env.send(&[sv::withdraw(b.pubkey(), &l.ph)], &cranker, &[&b]));
    assert_eq!(env.lamports(&b.pubkey()) - before, LAMPORTS_PER_SOL);
    assert_eq!(env.state(&l.ph).total_withdrawn, 2 * LAMPORTS_PER_SOL);
}

#[test]
fn clm10_places_are_independent_and_fake_state_refused() {
    let mut env = Env::initialized();
    let x = env.launch("place-x", 0);
    let y = env.launch("place-y", 0);
    let y_before = env.account(&y.state).unwrap();
    let owner = env.funded(1);
    ok(env.request_claim(&x.ph, &owner, 1));
    assert_eq!(env.account(&y.state).unwrap(), y_before, "claiming X leaves Y untouched");
    assert!(env.state(&x.ph).has_pending);

    let attestor = env.attestor.insecure_clone();
    let cranker = env.cranker.insecure_clone();
    // Fake VaultStates: a system-owned copy, a token-owned copy, Config itself, and an unregistered place.
    let real = env.account(&y.state).unwrap();
    let mut fakes = vec![sv::config_pda().0, sv::state_pda(&place_hash("never-launched")).0];
    for owner_prog in [sv::SYSTEM, SPL_TOKEN] {
        let k = Address::new_unique();
        env.svm.set_account(k, Account { owner: owner_prog, ..real.clone() }).unwrap();
        fakes.push(k);
    }
    for fake in fakes {
        let mut ix = sv::request_claim(attestor.pubkey(), owner.pubkey(), &y.ph, 1);
        ix.accounts[3].pubkey = fake;
        let r = env.send(&[ix], &owner, &[&attestor]);
        expect_custom(&r, e::INVALID_VAULT_STATE);
        let mut ix = sv::finalize_claim(&y.ph);
        ix.accounts[0].pubkey = fake;
        expect_custom(&env.send(&[ix], &cranker, &[]), e::INVALID_VAULT_STATE);
        let mut ix = sv::cancel_claim(attestor.pubkey(), &y.ph);
        ix.accounts[2].pubkey = fake;
        expect_custom(&env.send(&[ix], &cranker, &[&attestor]), e::INVALID_VAULT_STATE);
    }
    // Read-only vault_state.
    let mut ix = sv::request_claim(attestor.pubkey(), owner.pubkey(), &y.ph, 1);
    ix.accounts[3].is_writable = false;
    expect_custom(&env.send(&[ix], &owner, &[&attestor]), e::INVALID_VAULT_STATE);
    // Fake config (system-owned copy of the real bytes).
    let k = Address::new_unique();
    let cfg = env.account(&sv::config_pda().0).unwrap();
    env.svm.set_account(k, Account { owner: sv::SYSTEM, ..cfg }).unwrap();
    let mut ix = sv::request_claim(attestor.pubkey(), owner.pubkey(), &y.ph, 1);
    ix.accounts[2].pubkey = k;
    expect_custom(&env.send(&[ix], &owner, &[&attestor]), e::INVALID_CONFIG);
    assert_eq!(env.account(&y.state).unwrap(), y_before);
}

#[test]
fn clm11_claims_work_while_paused() {
    let (mut env, l) = setup();
    let grd = env.guardian.insecure_clone();
    let cranker = env.cranker.insecure_clone();
    ok(env.send(&[sv::set_paused(grd.pubkey(), 1)], &cranker, &[&grd]));
    let owner = env.claim_and_finalize(&l.ph);
    assert_eq!(env.state(&l.ph).owner, owner.pubkey());
    let b = env.funded(1);
    ok(env.request_claim(&l.ph, &b, 2));
    ok(env.send(&[sv::cancel_claim(b.pubkey(), &l.ph)], &cranker, &[&b]));
}

#[test]
fn clm12_resubmitted_identical_tx_is_rejected() {
    let (mut env, l) = setup();
    let owner = env.funded(1);
    let attestor = env.attestor.insecure_clone();
    let tx = env.tx(&[sv::request_claim(attestor.pubkey(), owner.pubkey(), &l.ph, 1)], &owner, &[&attestor]);
    ok(env.svm.send_transaction(tx.clone()));
    let r = env.svm.send_transaction(tx);
    expect_tx_err(&r, TransactionError::AlreadyProcessed);
    assert_eq!(env.state(&l.ph).claim_nonce, 1);
}

#[test]
fn clm13_bad_instruction_data() {
    let (mut env, l) = setup();
    let owner = env.funded(1);
    let attestor = env.attestor.insecure_clone();
    let good = sv::request_claim(attestor.pubkey(), owner.pubkey(), &l.ph, 1);
    for d in [good.data[..8].to_vec(), [good.data.clone(), vec![0]].concat()] {
        let mut ix = good.clone();
        ix.data = d;
        expect_custom(&env.send(&[ix], &owner, &[&attestor]), e::INVALID_INSTRUCTION);
    }
    for ix in [sv::cancel_claim(attestor.pubkey(), &l.ph), sv::finalize_claim(&l.ph)] {
        let mut ix = ix;
        ix.data.push(0);
        expect_custom(&env.send(&[ix], &owner, &[&attestor]), e::INVALID_INSTRUCTION);
    }
    for n in [3, 4] {
        let mut ix = good.clone();
        ix.accounts.truncate(n);
        expect_ix(&env.send(&[ix], &owner, &[&attestor]), InstructionError::NotEnoughAccountKeys);
    }
}
