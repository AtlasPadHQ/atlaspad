//! REVIEW-2 (adversarial): blast radius of a compromised governance key / attestor key, measured end to end.
//! Each test started as the reviewer's exploit and is now the regression test for its fix.
//!
//! R2-A1  A compromised governance could make itself the attestor after 7 days without a veto and then take every
//!        shop 72 h later. Fixed: the guardian (not the online attestor) vetoes and cancels claims without limit; every
//!        attestor change starts a 7-day probation (claims unlock no earlier than probation end + window, and owners
//!        may cancel them); a veto escalates the next proposal instead of allowing endless re-proposals.
//!        Residual (documented, SPEC T11): governance is the root of trust. By replacing the guardian first it can
//!        still take over, but no sooner than ≥ 7 d (+14 d per guardian veto) + 7 d probation + the claim window, in
//!        public, while owners keep withdrawing. r2_a1c measures that bound.
//! R2-A2  A cancel executing at/after unlock_ts is too late by design (cancel and finalize split time cleanly). Fixed
//!        operationally: the guardian has no time lock; SPEC §11 requires governance time_lock < window − 24 h.
//! R2-A3  A devnet binary was indistinguishable from a mainnet one and rotated in 300 s. Fixed: the devnet build
//!        refuses the mainnet window (max 24 h), records its flavour in Config and the init event, and builds into
//!        its own directory.
#![allow(clippy::result_large_err, deprecated)]
mod common;

use common::*;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;

const OWNED: &str = "review2-owned-shop";
const UNCLAIMED: &str = "review2-unclaimed-shop";

fn run(env: &mut Env, ixs: &[Instruction], signers: &[&Keypair]) {
    let cranker = env.cranker.insecure_clone();
    ok(env.send(ixs, &cranker, signers));
}

fn donate(env: &mut Env, to: &Address, lamports: u64) {
    let d = env.funded(lamports / LAMPORTS_PER_SOL + 1);
    ok(env.send(&[system_transfer(d.pubkey(), *to, lamports)], &d, &[]));
}

fn try_send(env: &mut Env, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair], what: &str) -> bool {
    let r = env.send(ixs, payer, extra);
    println!("{what}: {}", match &r { Ok(_) => "ok".to_string(), Err(f) => format!("refused {:?}", f.err) });
    r.is_ok()
}

/// FIXED (was a confirmed exploit). Secure property: with the governance key ALONE compromised (attestor, guardian and
/// Worker honest), proposing a rogue attestor and waiting out the delay does not let the attacker own any shop or
/// withdraw anything, however long it keeps trying, as long as the guardian keeps cancelling rogue claims. Attack
/// steps tolerate refusal; defenders make the moves the program offers them.
#[test]
fn r2_a1_compromised_governance_drains_every_shop_after_7d_plus_window() {
    let mut env = Env::initialized();
    let owned = env.launch(OWNED, 0);
    let unclaimed = env.launch(UNCLAIMED, 0);
    let owner = env.claim_and_finalize(&owned.ph);
    donate(&mut env, &owned.vault, 3 * LAMPORTS_PER_SOL);
    donate(&mut env, &unclaimed.vault, 5 * LAMPORTS_PER_SOL);
    let cranker = env.cranker.insecure_clone();

    // 1. The attacker holds the governance key only.
    let gov = env.governance.insecure_clone();
    let guardian = env.guardian.insecure_clone();
    let rogue_attestor = Keypair::new();
    try_send(&mut env, &[sv::propose_attestor(gov.pubkey(), rogue_attestor.pubkey())], &cranker, &[&gov], "governance proposes rogue attestor");
    // 2. Nobody vetoes for 7 days; anyone applies it. This starts a probation.
    env.warp(sv::ROTATION_DELAY);
    let anyone = env.funded(1);
    let t_applied = env.now();
    try_send(&mut env, &[sv::accept_attestor(anyone.pubkey())], &anyone, &[], "anyone applies the rotation after 7 d");
    assert_eq!(env.config().probation_until, t_applied + sv::PROBATION);
    // 3. The rogue attestor co-signs claims to the attacker's wallet on both shops, over and over, for 60 days.
    let thief = env.funded(1);
    let end = env.now() + 60 * 86_400;
    let mut rounds = 0;
    while env.now() < end {
        for ph in [owned.ph, unclaimed.ph] {
            let nonce = env.state(&ph).claim_nonce + 1;
            if try_send(&mut env, &[sv::request_claim(rogue_attestor.pubkey(), thief.pubkey(), &ph, nonce)], &thief, &[&rogue_attestor], "rogue request_claim") {
                let st = env.state(&ph);
                assert!(st.unlock_ts >= t_applied + sv::PROBATION + WINDOW_72H, "no rogue claim can finalize before probation + window");
            }
        }
        // 4. Defenders: the owner cancels claims on its own shop while they are flagged (probation); the guardian
        //    cancels the rest. The owner also keeps withdrawing.
        for ph in [owned.ph, unclaimed.ph] {
            if !env.state(&ph).has_pending {
                continue;
            }
            if ph == owned.ph && env.state(&ph).pending_flags == 1 {
                try_send(&mut env, &[sv::cancel_claim(owner.pubkey(), &ph)], &cranker, &[&owner], "owner cancels (probation)");
            } else {
                try_send(&mut env, &[sv::cancel_claim(guardian.pubkey(), &ph)], &cranker, &[&guardian], "guardian cancels");
            }
        }
        try_send(&mut env, &[sv::withdraw(owner.pubkey(), &owned.ph)], &cranker, &[&owner], "owner withdraws");
        // 5. The attacker also tries to finalize.
        for ph in [owned.ph, unclaimed.ph] {
            try_send(&mut env, &[sv::finalize_claim(&ph)], &cranker, &[], "finalize");
        }
        env.warp(WINDOW_72H / 2);
        rounds += 1;
    }
    donate(&mut env, &owned.vault, 2 * LAMPORTS_PER_SOL);
    let t0 = env.lamports(&thief.pubkey());
    for ph in [owned.ph, unclaimed.ph] {
        try_send(&mut env, &[sv::withdraw(thief.pubkey(), &ph)], &cranker, &[&thief], "thief withdraws");
    }
    let stolen = env.lamports(&thief.pubkey()).saturating_sub(t0);
    let hijacked = [owned.ph, unclaimed.ph].iter().filter(|ph| env.state(ph).owner == thief.pubkey()).count();
    println!("R2-A1: {rounds} rounds over 60 days; stolen {stolen}, hijacked {hijacked}");
    assert!(stolen == 0 && hijacked == 0, "R2-A1: attacker owns {hijacked}/2 shops and withdrew {stolen} lamports");
    assert_eq!(env.state(&owned.ph).owner, owner.pubkey());
    assert!(!env.state(&unclaimed.ph).has_owner);
}

/// FIXED. Exploit: after a veto, governance could re-propose at once, forcing a veto every 7 days forever. Now a veto
/// makes the next proposal escalated (14 days, no veto), which ends the loop in one bounded step; and the veto
/// belongs to the offline guardian, not the online attestor.
#[test]
fn r2_a1b_the_only_defence_is_a_live_attestor_veto_within_7_days() {
    let mut env = Env::initialized();
    let gov = env.governance.insecure_clone();
    let att = env.attestor.insecure_clone();
    let grd = env.guardian.insecure_clone();
    let rogue = Keypair::new();
    run(&mut env, &[sv::propose_attestor(gov.pubkey(), rogue.pubkey())], &[&gov]);
    let cranker = env.cranker.insecure_clone();
    expect_custom(&env.send(&[sv::cancel_attestor_proposal(att.pubkey())], &cranker, &[&att]), e::UNAUTHORIZED);
    env.warp(sv::ROTATION_DELAY - 1);
    run(&mut env, &[sv::cancel_attestor_proposal(grd.pubkey())], &[&grd]);
    let t = env.now();
    run(&mut env, &[sv::propose_attestor(gov.pubkey(), rogue.pubkey())], &[&gov]);
    let c = env.config();
    assert_eq!((c.pending_attestor, c.pending_attestor_eta), (rogue.pubkey(), t + sv::ESCALATED_DELAY));
    assert_eq!(c.flags & sv::FLAG_ATTESTOR_VETOED, sv::FLAG_ATTESTOR_VETOED);
    expect_custom(&env.send(&[sv::cancel_attestor_proposal(grd.pubkey())], &cranker, &[&grd]), e::PROPOSAL_ESCALATED);
}

/// RESIDUAL RISK, BOUNDED (SPEC T11): governance is the root of trust. Its fastest takeover path replaces the guardian
/// first (the guardian vetoes once; the escalated proposal applies after 14 days), then has its own guardian consent
/// to a rogue attestor. That attestor change still starts a probation: during it the owner blocks rogue claims and
/// keeps withdrawing; afterwards nobody honest can cancel. This test pins the earliest time the attacker can own a
/// shop, and checks the owner loses nothing it had withdrawn.
#[test]
fn r2_a1c_governance_takeover_via_guardian_swap_is_slow_and_public() {
    let mut env = Env::initialized();
    let owned = env.launch(OWNED, 0);
    let unclaimed = env.launch(UNCLAIMED, 0);
    let owner = env.claim_and_finalize(&owned.ph);
    let cranker = env.cranker.insecure_clone();
    let gov = env.governance.insecure_clone();
    let honest_guardian = env.guardian.insecure_clone();
    let (rogue_guardian, rogue_attestor) = (Keypair::new(), Keypair::new());
    let t0 = env.now();

    // The honest guardian vetoes the first swap; the escalated one cannot be vetoed and applies after 14 days.
    run(&mut env, &[sv::propose_guardian(gov.pubkey(), rogue_guardian.pubkey())], &[&gov]);
    run(&mut env, &[sv::cancel_guardian_proposal(honest_guardian.pubkey())], &[&honest_guardian]);
    run(&mut env, &[sv::propose_guardian(gov.pubkey(), rogue_guardian.pubkey())], &[&gov]);
    let eta = env.config().pending_guardian_eta;
    assert_eq!(eta, t0 + sv::ESCALATED_DELAY);
    env.set_time(eta);
    run(&mut env, &[sv::accept_guardian(cranker.pubkey())], &[]);
    // The rogue guardian consents to the rogue attestor at once, but the attestor change starts a probation.
    run(&mut env, &[sv::propose_attestor(gov.pubkey(), rogue_attestor.pubkey()), sv::accept_attestor(rogue_guardian.pubkey())], &[&gov, &rogue_guardian]);
    let probation_until = env.config().probation_until;
    assert_eq!(probation_until, eta + sv::PROBATION);
    let thief = env.funded(1);
    for ph in [owned.ph, unclaimed.ph] {
        let nonce = env.state(&ph).claim_nonce + 1;
        run(&mut env, &[sv::request_claim(rogue_attestor.pubkey(), thief.pubkey(), &ph, nonce)], &[&thief, &rogue_attestor]);
        assert_eq!(env.state(&ph).unlock_ts, probation_until + WINDOW_72H);
    }
    // The owner blocks the rogue claim on its shop and withdraws; the unclaimed shop has no honest canceller left.
    run(&mut env, &[sv::cancel_claim(owner.pubkey(), &owned.ph)], &[&owner]);
    donate(&mut env, &owned.vault, LAMPORTS_PER_SOL);
    let before = env.lamports(&owner.pubkey());
    run(&mut env, &[sv::withdraw(owner.pubkey(), &owned.ph)], &[&owner]);
    assert_eq!(env.lamports(&owner.pubkey()) - before, LAMPORTS_PER_SOL);
    // Earliest takeover of the unclaimed shop: escalated swap (14 d) + probation (7 d) + window (72 h) after the
    // first proposal.
    env.set_time(probation_until + WINDOW_72H - 1);
    expect_custom(&env.send(&[sv::finalize_claim(&unclaimed.ph)], &cranker, &[]), e::CLAIM_WINDOW_ACTIVE);
    env.warp(1);
    ok(env.send(&[sv::finalize_claim(&unclaimed.ph)], &cranker, &[]));
    assert_eq!(env.state(&unclaimed.ph).owner, thief.pubkey());
    let elapsed = env.now() - t0;
    assert_eq!(elapsed, sv::ESCALATED_DELAY + sv::PROBATION + WINDOW_72H);
    println!("R2-A1c: governance-only takeover of an unclaimed shop takes >= {} days (with one guardian veto)", elapsed / 86_400);
    // After probation the owner can no longer cancel a fresh rogue claim on its own shop (D6) — it must have withdrawn.
    let nonce = env.state(&owned.ph).claim_nonce + 1;
    run(&mut env, &[sv::request_claim(rogue_attestor.pubkey(), thief.pubkey(), &owned.ph, nonce)], &[&thief, &rogue_attestor]);
    expect_custom(&env.send(&[sv::cancel_claim(owner.pubkey(), &owned.ph)], &cranker, &[&owner]), e::UNAUTHORIZED);
}

/// By design a cancel at/after unlock_ts is too late (the reviewer's timelocked-Squads case). Fixed operationally:
/// the guardian, which has no multisig time lock, can always cancel inside the window, and SPEC §11 requires the
/// governance multisig's time_lock to stay below claim_window_secs − 24 h.
#[test]
fn r2_a2_cancel_that_executes_at_unlock_is_too_late() {
    let mut env = Env::initialized();
    let shop = env.launch(UNCLAIMED, 0);
    donate(&mut env, &shop.vault, LAMPORTS_PER_SOL);
    let thief = env.funded(1);
    let att = env.attestor.insecure_clone();
    let nonce = env.state(&shop.ph).claim_nonce + 1;
    ok(env.send(&[sv::request_claim(att.pubkey(), thief.pubkey(), &shop.ph, nonce)], &thief, &[&att]));
    let unlock = env.state(&shop.ph).unlock_ts;
    let (gov, grd) = (env.governance.insecure_clone(), env.guardian.insecure_clone());
    let cranker = env.cranker.insecure_clone();
    // At unlock_ts any cancel is refused (governance or guardian alike).
    env.set_time(unlock);
    for k in [&gov, &grd] {
        expect_custom(&env.send(&[sv::cancel_claim(k.pubkey(), &shop.ph)], &cranker, &[k]), e::CLAIM_WINDOW_ELAPSED);
    }
    // One second earlier, the guardian's cancel lands and the rogue claim never finalizes.
    let mut env = Env::initialized();
    let shop = env.launch(UNCLAIMED, 0);
    let att = env.attestor.insecure_clone();
    let grd = env.guardian.insecure_clone();
    let cranker = env.cranker.insecure_clone();
    ok(env.send(&[sv::request_claim(att.pubkey(), thief.pubkey(), &shop.ph, 1)], &cranker, &[&att, &thief]));
    let unlock = env.state(&shop.ph).unlock_ts;
    env.set_time(unlock - 1);
    run(&mut env, &[sv::cancel_claim(grd.pubkey(), &shop.ph)], &[&grd]);
    env.warp(1);
    expect_custom(&env.send(&[sv::finalize_claim(&shop.ph)], &cranker, &[]), e::NO_PENDING_CLAIM);
}

/// FIXED. Exploit: the devnet binary accepted the mainnet window (259,200 s), produced a Config identical to a
/// mainnet one, and let anyone swap the attestor after 300 s. Now it refuses that window (devnet max 24 h), and any
/// Config it does create says `flavor = 1` with a 300 s rotation delay (and the init event carries the marker).
#[test]
fn r2_a3_devnet_binary_with_mainnet_window_is_indistinguishable_but_rotates_in_300s() {
    assert!(devnet_so_available(), "target/deploy-devnet/shop_vault.so missing: run scripts/build.sh");
    let mut env = Env::with_program(true);
    expect_custom(&env.init_config(WINDOW_72H), e::INVALID_WINDOW);
    assert!(env.account(&sv::config_pda().0).map(|a| a.owner != PROGRAM_ID).unwrap_or(true), "no Config created");
    // The largest window a devnet binary accepts is visibly a devnet Config.
    let m = ok(env.init_config(sv::DEVNET_MAX_WINDOW));
    let c = env.config();
    assert_eq!((c.flavor, c.rotation_delay_secs, c.claim_window_secs), (1, sv::DEVNET_ROTATION_DELAY, sv::DEVNET_MAX_WINDOW));
    assert_eq!(program_events(&m, "ConfigInitialized")[0][5], b"shop-vault-build:devnet".to_vec());
    // The mainnet binary records itself as such.
    let mut main = Env::new();
    ok(main.init_config(WINDOW_72H));
    assert_eq!((main.config().flavor, main.config().rotation_delay_secs), (0, sv::ROTATION_DELAY));
}
