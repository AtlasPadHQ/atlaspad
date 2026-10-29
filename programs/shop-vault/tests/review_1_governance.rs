//! Review 1 (adversarial): attestor / governance rotation paths (SPEC D9, §5.8, T10, T11).
//!
//! Each test started life as the reviewer's exploit and is now the regression test for its fix:
//! - stale attestor proposal survived a governance handover      → accept_governance clears every pending proposal
//! - a hostile attestor vetoed rotation and cancelled every claim → the attestor has no admin power; the guardian
//!   consents to rotations, and its own veto is escalated away
//! - governance was irremovable and could cancel every claim     → governance cancels are capped per place; a lost
//!   governance is recoverable by the guardian after 30 days
//! - a pending governance proposal could not be withdrawn         → zero key withdraws; proposals expire after 30 d
#![allow(clippy::result_large_err, deprecated)]
mod common;

use common::*;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

const ROTATION_DELAY: i64 = 604_800;

/// FIXED. Exploit: compromised governance G1 proposed the attacker's attestor; the operator handed governance to G2;
/// the proposal survived and anyone applied it after 7 days. Now the handover clears it (and any guardian proposal),
/// so nothing can be applied and the attacker key never becomes the attestor.
#[test]
fn r1_stale_attestor_proposal_survives_governance_handover() {
    let mut env = Env::initialized();
    let g1 = env.governance.insecure_clone();
    let payer = env.funded(5);
    let attacker_attestor = Keypair::new();
    let attacker_guardian = Keypair::new();
    let shop = env.launch("r1:gov-shop", 0);

    // Compromised governance key G1 proposes the attacker's attestor (and guardian).
    ok(env.send(
        &[sv::propose_attestor(g1.pubkey(), attacker_attestor.pubkey()), sv::propose_guardian(g1.pubkey(), attacker_guardian.pubkey())],
        &payer,
        &[&g1],
    ));
    // Operator response: hand governance to a fresh multisig G2 (two-step), as the runbook prescribes.
    let g2 = Keypair::new();
    ok(env.send(&[sv::propose_governance(g1.pubkey(), g2.pubkey())], &payer, &[&g1]));
    ok(env.send(&[sv::accept_governance(g2.pubkey())], &payer, &[&g2]));
    let c = env.config();
    assert_eq!(c.governance, g2.pubkey());
    assert_eq!(c.pending_attestor, Address::default(), "handover cleared the attacker's attestor proposal");
    assert_eq!(c.pending_guardian, Address::default(), "handover cleared the attacker's guardian proposal");

    // 7 days later nobody can apply anything.
    env.warp(ROTATION_DELAY);
    let attacker_payer = env.funded(1);
    expect_custom(&env.send(&[sv::accept_attestor(attacker_payer.pubkey())], &attacker_payer, &[]), e::NO_PENDING_ROTATION);
    expect_custom(&env.send(&[sv::accept_guardian(attacker_payer.pubkey())], &attacker_payer, &[]), e::NO_PENDING_ROTATION);
    assert_ne!(env.config().attestor, attacker_attestor.pubkey());

    // The attacker's key cannot open claims.
    let thief = env.funded(1);
    let ix = sv::request_claim(attacker_attestor.pubkey(), thief.pubkey(), &shop.ph, 1);
    expect_custom(&env.send(&[ix], &thief, &[&attacker_attestor]), e::ATTESTOR_MISMATCH);
    assert!(!env.state(&shop.ph).has_pending);
}

/// FIXED. Exploit: a leaked attestor key vetoed every governance rotation and cancelled every claim. Now the online
/// attestor has no admin power at all: it cannot veto, cancel, pause, or apply a rotation; the guardian consents and
/// the rotation is immediate even if the operator no longer holds the attestor key.
#[test]
fn r1_hostile_attestor_vetoes_rotation_and_cancels_claims_indefinitely() {
    let mut env = Env::initialized();
    let gov = env.governance.insecure_clone();
    let grd = env.guardian.insecure_clone();
    let thief_attestor = env.attestor.insecure_clone(); // leaked copy; the operator lost its own
    let payer = env.funded(5);
    let shop = env.launch("r1:veto-shop", 0);
    let replacement = Keypair::new();

    // A claim opened before the rotation; the thief cannot cancel it, nor veto, pause or apply rotations.
    let owner = env.funded(1);
    ok(env.request_claim(&shop.ph, &owner, 1));
    ok(env.send(&[sv::propose_attestor(gov.pubkey(), replacement.pubkey())], &payer, &[&gov]));
    for ix in [
        sv::cancel_attestor_proposal(thief_attestor.pubkey()),
        sv::cancel_claim(thief_attestor.pubkey(), &shop.ph),
        sv::set_paused(thief_attestor.pubkey(), 1),
    ] {
        expect_custom(&env.send(&[ix], &payer, &[&thief_attestor]), e::UNAUTHORIZED);
    }
    expect_custom(&env.send(&[sv::accept_attestor(thief_attestor.pubkey())], &payer, &[&thief_attestor]), e::ROTATION_NOT_READY);
    assert!(env.state(&shop.ph).has_pending);

    // The guardian consents: the rotation applies at once.
    ok(env.send(&[sv::accept_attestor(grd.pubkey())], &payer, &[&grd]));
    assert_eq!(env.config().attestor, replacement.pubkey());
    // The leaked key is now useless for claims and launches.
    let thief = env.funded(1);
    expect_custom(&env.send(&[sv::request_claim(thief_attestor.pubkey(), thief.pubkey(), &shop.ph, 2)], &thief, &[&thief_attestor]), e::ATTESTOR_MISMATCH);
    // The legitimate claim finalizes.
    let unlock = env.state(&shop.ph).unlock_ts;
    env.set_time(unlock);
    ok(env.send(&[sv::finalize_claim(&shop.ph)], &payer, &[]));
    assert_eq!(env.state(&shop.ph).owner, owner.pubkey());
}

/// The veto power moved to the guardian; a hostile guardian cannot use it as a permanent veto either: one veto per
/// kind, then governance's escalated proposal (14 d) applies without it. Governance can also replace the guardian.
#[test]
fn r1_hostile_guardian_veto_is_bounded() {
    let mut env = Env::initialized();
    let gov = env.governance.insecure_clone();
    let hostile = env.guardian.insecure_clone();
    let payer = env.funded(5);
    let (new_att, new_grd) = (Keypair::new(), Keypair::new());
    let t0 = env.now();
    ok(env.send(&[sv::propose_attestor(gov.pubkey(), new_att.pubkey()), sv::propose_guardian(gov.pubkey(), new_grd.pubkey())], &payer, &[&gov]));
    ok(env.send(&[sv::cancel_attestor_proposal(hostile.pubkey()), sv::cancel_guardian_proposal(hostile.pubkey())], &payer, &[&hostile]));
    ok(env.send(&[sv::propose_attestor(gov.pubkey(), new_att.pubkey()), sv::propose_guardian(gov.pubkey(), new_grd.pubkey())], &payer, &[&gov]));
    for ix in [sv::cancel_attestor_proposal(hostile.pubkey()), sv::cancel_guardian_proposal(hostile.pubkey())] {
        expect_custom(&env.send(&[ix], &payer, &[&hostile]), e::PROPOSAL_ESCALATED);
    }
    env.set_time(t0 + sv::ESCALATED_DELAY);
    let anyone = env.funded(1);
    ok(env.send(&[sv::accept_guardian(anyone.pubkey()), sv::accept_attestor(anyone.pubkey())], &anyone, &[]));
    let c = env.config();
    assert_eq!((c.attestor, c.guardian), (new_att.pubkey(), new_grd.pubkey()));
    expect_custom(&env.send(&[sv::set_paused(hostile.pubkey(), 1)], &payer, &[&hostile]), e::UNAUTHORIZED);
}

/// FIXED. Exploit: governance cancelled every phone-verified claim forever and nothing could replace it. Now
/// governance can cancel at most MAX_GOVERNANCE_SOLO_CANCELS claims per place, after which the claim finalizes; and
/// a lost (or unresponsive) governance can be replaced by the guardian after 30 days unless it objects.
#[test]
fn r1_governance_is_irremovable_and_can_cancel_every_claim() {
    let mut env = Env::initialized();
    let gov = env.governance.insecure_clone();
    let grd = env.guardian.insecure_clone();
    let attestor = env.attestor.insecure_clone();
    let payer = env.funded(5);
    let shop = env.launch("r1:gov-cancel", 0);

    // The attestor still cannot propose a governance change.
    let r = env.send(&[sv::propose_governance(attestor.pubkey(), Keypair::new().pubkey())], &payer, &[&attestor]);
    expect_custom(&r, e::UNAUTHORIZED);

    let mut cancelled = 0;
    let owner = loop {
        let owner = env.funded(1);
        let nonce = env.state(&shop.ph).claim_nonce + 1;
        ok(env.request_claim(&shop.ph, &owner, nonce));
        env.warp(WINDOW_72H - 1);
        let r = env.send(&[sv::cancel_claim(gov.pubkey(), &shop.ph)], &payer, &[&gov]);
        if r.is_err() {
            expect_custom(&r, e::GOVERNANCE_CANCEL_LIMIT);
            break owner;
        }
        cancelled += 1;
        assert!(cancelled <= sv::MAX_GOVERNANCE_SOLO_CANCELS, "governance cancel budget exceeded");
    };
    assert_eq!(cancelled, sv::MAX_GOVERNANCE_SOLO_CANCELS);
    env.warp(1);
    ok(env.send(&[sv::finalize_claim(&shop.ph)], &payer, &[]));
    assert_eq!(env.state(&shop.ph).owner, owner.pubkey(), "the shop gets its owner despite a hostile governance");

    // Governance is replaceable when lost: guardian recovery, 30 days, no objection.
    let recovered = Keypair::new();
    ok(env.send(&[sv::propose_governance(grd.pubkey(), recovered.pubkey())], &payer, &[&grd]));
    env.warp(sv::RECOVERY_DELAY);
    ok(env.send(&[sv::accept_governance(recovered.pubkey())], &payer, &[&recovered]));
    assert_eq!(env.config().governance, recovered.pubkey());
}

/// FIXED. Exploit: a governance proposal could not be withdrawn and stayed acceptable forever. Now the zero key
/// withdraws it, and an unaccepted proposal expires after 30 days.
#[test]
fn r1_pending_governance_cannot_be_withdrawn() {
    let mut env = Env::initialized();
    let gov = env.governance.insecure_clone();
    let payer = env.funded(5);
    let wrong = Keypair::new();
    ok(env.send(&[sv::propose_governance(gov.pubkey(), wrong.pubkey())], &payer, &[&gov]));
    ok(env.send(&[sv::propose_governance(gov.pubkey(), Address::default())], &payer, &[&gov]));
    assert_eq!(env.config().pending_governance, Address::default());
    expect_custom(&env.send(&[sv::accept_governance(wrong.pubkey())], &payer, &[&wrong]), e::NO_PENDING_GOVERNANCE);
    // Even if nobody withdraws it, a year later it has expired.
    ok(env.send(&[sv::propose_governance(gov.pubkey(), wrong.pubkey())], &payer, &[&gov]));
    env.warp(365 * 86_400);
    expect_custom(&env.send(&[sv::accept_governance(wrong.pubkey())], &payer, &[&wrong]), e::PROPOSAL_EXPIRED);
    assert_eq!(env.config().governance, gov.pubkey());
}
