//! ADM-*: pause, attestor and guardian rotation (propose → the guardian consents at once, or anyone applies after
//! 7 days; a guardian veto escalates the next proposal to 14 days with no veto), probation after attestor changes,
//! governance handover (withdrawable, expiring, clears stale proposals) and governance recovery by the guardian
//! (SPEC §5.8, D9).
#![allow(clippy::result_large_err, deprecated)]
mod common;

use common::*;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;

const PLACE: &str = "ChIJN1t_tDeuEmsRUsoyG83frY4";
const DELAY: i64 = sv::ROTATION_DELAY;

fn cfg_key() -> Address {
    sv::config_pda().0
}

#[track_caller]
fn fails_no_change(env: &mut Env, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
    let before = env.snapshot(&[cfg_key()]);
    let cranker = env.cranker.insecure_clone();
    let r = env.send(ixs, &cranker, signers);
    assert!(r.is_err(), "expected failure");
    assert_eq!(env.snapshot(&[cfg_key()]), before, "failed admin tx changed Config");
    r
}

fn run(env: &mut Env, ixs: &[Instruction], signers: &[&Keypair]) -> litesvm::types::TransactionMetadata {
    let cranker = env.cranker.insecure_clone();
    ok(env.send(ixs, &cranker, signers))
}

struct Keys {
    att: Keypair,
    gov: Keypair,
    grd: Keypair,
}

fn keys(env: &Env) -> Keys {
    Keys { att: env.attestor.insecure_clone(), gov: env.governance.insecure_clone(), grd: env.guardian.insecure_clone() }
}

#[test]
fn adm01_set_paused() {
    let mut env = Env::initialized();
    let Keys { att, gov, grd } = keys(&env);
    let m = run(&mut env, &[sv::set_paused(grd.pubkey(), 1)], &[&grd]);
    assert_eq!(env.config().paused, 1);
    assert!(shop_vault_cu(&m)[0] <= 4_000);
    let ev = program_events(&m, "AdminChanged");
    assert_eq!((ev[0][1].clone(), ev[0][2].clone(), ev[0][3].clone()), (vec![0], vec![1], grd.pubkey().as_ref().to_vec()));
    run(&mut env, &[sv::set_paused(gov.pubkey(), 0)], &[&gov]);
    assert_eq!(env.config().paused, 0);
    run(&mut env, &[sv::set_paused(gov.pubkey(), 1)], &[&gov]);
    run(&mut env, &[sv::set_paused(gov.pubkey(), 1)], &[&gov]); // idempotent
    // The online attestor has no admin power (review finding R1); nor does a stranger.
    let stranger = Keypair::new();
    for k in [&att, &stranger] {
        expect_custom(&fails_no_change(&mut env, &[sv::set_paused(k.pubkey(), 0)], &[k]), e::UNAUTHORIZED);
    }
    expect_custom(&fails_no_change(&mut env, &[sv::set_paused(gov.pubkey(), 2)], &[&gov]), e::INVALID_INSTRUCTION);
    let mut ix = sv::set_paused(gov.pubkey(), 0);
    ix.accounts[0].is_signer = false;
    expect_ix(&fails_no_change(&mut env, &[ix], &[]), InstructionError::MissingRequiredSignature);
    let mut ix = sv::set_paused(gov.pubkey(), 0);
    ix.accounts[1].is_writable = false;
    expect_custom(&fails_no_change(&mut env, &[ix], &[&gov]), e::ACCOUNT_NOT_WRITABLE);
    let mut ix = sv::set_paused(gov.pubkey(), 0);
    ix.data = vec![7];
    expect_custom(&fails_no_change(&mut env, &[ix], &[&gov]), e::INVALID_INSTRUCTION);
}

#[test]
fn adm02_propose_rules() {
    let mut env = Env::initialized();
    let Keys { att, gov, grd } = keys(&env);
    let new = Keypair::new();
    let stranger = Keypair::new();
    type Propose = fn(Address, Address) -> Instruction;
    for (propose, other) in [(sv::propose_attestor as Propose, grd.pubkey()), (sv::propose_guardian as Propose, att.pubkey())] {
        // Only governance proposes.
        for k in [&att, &grd, &stranger] {
            expect_custom(&fails_no_change(&mut env, &[propose(k.pubkey(), new.pubkey())], &[k]), e::UNAUTHORIZED);
        }
        // The three keys stay distinct and non-zero.
        for bad in [Address::default(), gov.pubkey(), other] {
            expect_custom(&fails_no_change(&mut env, &[propose(gov.pubkey(), bad)], &[&gov]), e::INVALID_AUTHORITY_KEY);
        }
    }
    let now = env.now();
    let m = run(&mut env, &[sv::propose_attestor(gov.pubkey(), new.pubkey())], &[&gov]);
    let c = env.config();
    assert_eq!((c.pending_attestor, c.pending_attestor_eta), (new.pubkey(), now + DELAY));
    assert_eq!(c.attestor, att.pubkey(), "proposal alone changes nothing");
    assert!(shop_vault_cu(&m)[0] <= 4_000);
    let ev = program_events(&m, "AdminChanged");
    assert_eq!((ev[0][1].clone(), ev[0][4].clone()), (vec![1], vec![0]), "kind 1, not escalated");
    // A second proposal overwrites the first.
    let newer = Keypair::new();
    env.warp(100);
    run(&mut env, &[sv::propose_attestor(gov.pubkey(), newer.pubkey())], &[&gov]);
    assert_eq!(env.config().pending_attestor, newer.pubkey());
    assert_eq!(env.config().pending_attestor_eta, now + 100 + DELAY);
    // Guardian proposals are independent of attestor proposals.
    let g2 = Keypair::new();
    run(&mut env, &[sv::propose_guardian(gov.pubkey(), g2.pubkey())], &[&gov]);
    let c = env.config();
    assert_eq!((c.pending_guardian, c.pending_guardian_eta, c.pending_attestor), (g2.pubkey(), now + 100 + DELAY, newer.pubkey()));
}

#[test]
fn adm03_accept_now_by_guardian_or_after_eta_by_anyone() {
    let mut env = Env::initialized();
    let Keys { att, gov, grd } = keys(&env);
    let stranger = Keypair::new();
    expect_custom(&fails_no_change(&mut env, &[sv::accept_attestor(grd.pubkey())], &[&grd]), e::NO_PENDING_ROTATION);
    // By the guardian: immediate. The new attestor starts a probation.
    let a2 = Keypair::new();
    run(&mut env, &[sv::propose_attestor(gov.pubkey(), a2.pubkey())], &[&gov]);
    let t = env.now();
    let m = run(&mut env, &[sv::accept_attestor(grd.pubkey())], &[&grd]);
    let c = env.config();
    assert_eq!((c.attestor, c.pending_attestor, c.pending_attestor_eta), (a2.pubkey(), Address::default(), 0));
    assert_eq!(c.probation_until, t + sv::PROBATION);
    let ev = program_events(&m, "AdminChanged");
    assert_eq!((ev[0][1].clone(), ev[0][4].clone()), (vec![2], vec![1]), "applied with consent");
    // The old (online) attestor cannot apply a rotation early (review finding R1); nor can governance or a stranger.
    let a3 = Keypair::new();
    run(&mut env, &[sv::propose_attestor(gov.pubkey(), a3.pubkey())], &[&gov]);
    let eta = env.config().pending_attestor_eta;
    for k in [&a2, &att, &gov, &stranger] {
        expect_custom(&fails_no_change(&mut env, &[sv::accept_attestor(k.pubkey())], &[k]), e::ROTATION_NOT_READY);
    }
    env.set_time(eta - 1);
    expect_custom(&fails_no_change(&mut env, &[sv::accept_attestor(stranger.pubkey())], &[&stranger]), e::ROTATION_NOT_READY);
    env.set_time(eta);
    run(&mut env, &[sv::accept_attestor(stranger.pubkey())], &[&stranger]);
    assert_eq!(env.config().attestor, a3.pubkey());
    assert_eq!(env.config().probation_until, eta + sv::PROBATION);
    // Caller must sign.
    run(&mut env, &[sv::propose_attestor(gov.pubkey(), a2.pubkey())], &[&gov]);
    let mut ix = sv::accept_attestor(grd.pubkey());
    ix.accounts[0].is_signer = false;
    expect_ix(&fails_no_change(&mut env, &[ix], &[]), InstructionError::MissingRequiredSignature);
}

#[test]
fn adm04_old_attestor_loses_launch_and_claim_power() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let Keys { att: old, gov, grd } = keys(&env);
    let new = Keypair::new();
    run(&mut env, &[sv::propose_attestor(gov.pubkey(), new.pubkey()), sv::accept_attestor(grd.pubkey())], &[&gov, &grd]);
    // Old attestor: launch and claim refused.
    let launcher = env.funded(5);
    let mint = Keypair::new();
    let ph2 = place_hash("place-two");
    let ixs = env.launch_ixs(&launcher.pubkey(), &mint.pubkey(), &ph2, &CreateArgs::sol(sv::vault_pda(&ph2).0), 0);
    let r = env.send(&ixs, &launcher, &[&mint, &old]);
    expect_custom_at(&r, 2, e::ATTESTOR_MISMATCH);
    let owner = env.funded(1);
    let r = env.send(&[sv::request_claim(old.pubkey(), owner.pubkey(), &l.ph, 1)], &owner, &[&old]);
    expect_custom(&r, e::ATTESTOR_MISMATCH);
    // New attestor works for both.
    env.attestor = new.insecure_clone();
    env.try_launch("place-two", &launcher, &mint, 0).unwrap_or_else(|f| panic!("{}", fail_str(&f)));
    ok(env.request_claim(&l.ph, &owner, 1));
    // Neither the old nor the new attestor has any admin power.
    for k in [&old, &new] {
        let r = env.send(&[sv::cancel_claim(k.pubkey(), &l.ph)], &owner, &[k]);
        expect_custom(&r, e::UNAUTHORIZED);
        for ix in [sv::set_paused(k.pubkey(), 1), sv::cancel_attestor_proposal(k.pubkey()), sv::propose_governance(k.pubkey(), Keypair::new().pubkey())] {
            expect_custom(&fails_no_change(&mut env, &[ix], &[k]), e::UNAUTHORIZED);
        }
    }
}

#[test]
fn adm05_cancel_proposal_and_escalation() {
    type Propose = fn(Address, Address) -> Instruction;
    type One = fn(Address) -> Instruction;
    let cases: [(Propose, One, One, u8); 2] = [
        (sv::propose_attestor, sv::accept_attestor, sv::cancel_attestor_proposal, sv::FLAG_ATTESTOR_VETOED),
        (sv::propose_guardian, sv::accept_guardian, sv::cancel_guardian_proposal, sv::FLAG_GUARDIAN_VETOED),
    ];
    for (propose, accept, cancel, flag) in cases {
        let mut env = Env::initialized();
        let Keys { att, gov, grd } = keys(&env);
        let stranger = Keypair::new();
        let pending = |env: &Env| {
            let c = env.config();
            if flag == sv::FLAG_ATTESTOR_VETOED { (c.pending_attestor, c.pending_attestor_eta) } else { (c.pending_guardian, c.pending_guardian_eta) }
        };
        let new = Keypair::new();
        expect_custom(&fails_no_change(&mut env, &[cancel(grd.pubkey())], &[&grd]), e::NO_PENDING_ROTATION);
        run(&mut env, &[propose(gov.pubkey(), new.pubkey())], &[&gov]);
        for k in [&stranger, &new, &att] {
            expect_custom(&fails_no_change(&mut env, &[cancel(k.pubkey())], &[k]), e::UNAUTHORIZED);
        }
        // Governance withdrawing its own proposal is not a veto.
        let m = run(&mut env, &[cancel(gov.pubkey())], &[&gov]);
        assert_eq!(pending(&env), (Address::default(), 0));
        assert_eq!(env.config().flags & flag, 0);
        assert_eq!(program_events(&m, "AdminChanged")[0][3], vec![role::GOVERNANCE]);
        // The guardian vetoes: cleared and the next proposal is escalated.
        run(&mut env, &[propose(gov.pubkey(), new.pubkey())], &[&gov]);
        let m = run(&mut env, &[cancel(grd.pubkey())], &[&grd]);
        assert_eq!(program_events(&m, "AdminChanged")[0][3], vec![role::GUARDIAN]);
        assert_eq!(pending(&env), (Address::default(), 0));
        assert_eq!(env.config().flags & flag, flag);
        expect_custom(&fails_no_change(&mut env, &[cancel(grd.pubkey())], &[&grd]), e::NO_PENDING_ROTATION);
        env.warp(DELAY + 1);
        expect_custom(&fails_no_change(&mut env, &[accept(stranger.pubkey())], &[&stranger]), e::NO_PENDING_ROTATION);
        // Escalated: 14 days, and the guardian cannot veto it (review finding R1: no permanent mutual veto).
        let t = env.now();
        let m = run(&mut env, &[propose(gov.pubkey(), new.pubkey())], &[&gov]);
        assert_eq!(program_events(&m, "AdminChanged")[0][4], vec![1], "escalated");
        assert_eq!(pending(&env), (new.pubkey(), t + sv::ESCALATED_DELAY));
        expect_custom(&fails_no_change(&mut env, &[cancel(grd.pubkey())], &[&grd]), e::PROPOSAL_ESCALATED);
        // Governance may still withdraw it; the escalation persists until a proposal is applied.
        run(&mut env, &[cancel(gov.pubkey())], &[&gov]);
        run(&mut env, &[propose(gov.pubkey(), new.pubkey())], &[&gov]);
        let eta = pending(&env).1;
        assert_eq!(eta, env.now() + sv::ESCALATED_DELAY);
        env.set_time(eta - 1);
        expect_custom(&fails_no_change(&mut env, &[accept(stranger.pubkey())], &[&stranger]), e::ROTATION_NOT_READY);
        env.set_time(eta);
        run(&mut env, &[accept(stranger.pubkey())], &[&stranger]);
        let c = env.config();
        assert_eq!(c.flags & flag, 0, "applying clears the escalation");
        assert_eq!(if flag == sv::FLAG_ATTESTOR_VETOED { c.attestor } else { c.guardian }, new.pubkey());
    }
}

#[test]
fn adm06_atomic_propose_and_accept() {
    let mut env = Env::initialized();
    let Keys { gov, grd, .. } = keys(&env);
    let new = Keypair::new();
    let m = run(&mut env, &[sv::propose_attestor(gov.pubkey(), new.pubkey()), sv::accept_attestor(grd.pubkey())], &[&gov, &grd]);
    assert_eq!(env.config().attestor, new.pubkey());
    let ev = program_events(&m, "AdminChanged");
    assert_eq!(ev.iter().map(|s| s[1][0]).collect::<Vec<_>>(), vec![1, 2]);
    // The guardian consents to an escalated proposal too.
    let x = Keypair::new();
    run(&mut env, &[sv::propose_attestor(gov.pubkey(), x.pubkey())], &[&gov]);
    run(&mut env, &[sv::cancel_attestor_proposal(grd.pubkey())], &[&grd]);
    run(&mut env, &[sv::propose_attestor(gov.pubkey(), x.pubkey()), sv::accept_attestor(grd.pubkey())], &[&gov, &grd]);
    assert_eq!(env.config().attestor, x.pubkey());
}

#[test]
fn adm07_governance_handover() {
    let mut env = Env::initialized();
    let Keys { att, gov, grd } = keys(&env);
    let new_gov = Keypair::new();
    let stranger = Keypair::new();
    expect_custom(&fails_no_change(&mut env, &[sv::accept_governance(new_gov.pubkey())], &[&new_gov]), e::NO_PENDING_GOVERNANCE);
    for k in [&att, &stranger] {
        expect_custom(&fails_no_change(&mut env, &[sv::propose_governance(k.pubkey(), new_gov.pubkey())], &[k]), e::UNAUTHORIZED);
    }
    for bad in [att.pubkey(), grd.pubkey(), gov.pubkey()] {
        expect_custom(&fails_no_change(&mut env, &[sv::propose_governance(gov.pubkey(), bad)], &[&gov]), e::INVALID_AUTHORITY_KEY);
    }
    // Nothing to withdraw yet.
    expect_custom(&fails_no_change(&mut env, &[sv::propose_governance(gov.pubkey(), Address::default())], &[&gov]), e::NO_PENDING_GOVERNANCE);
    let t = env.now();
    run(&mut env, &[sv::propose_governance(gov.pubkey(), new_gov.pubkey())], &[&gov]);
    let c = env.config();
    assert_eq!((c.pending_governance, c.pending_governance_eta, c.flags), (new_gov.pubkey(), t, 0));
    assert_eq!(c.governance, gov.pubkey(), "step 1 changes nothing yet");
    // Wrong signer for step 2.
    for k in [&stranger, &gov] {
        expect_custom(&fails_no_change(&mut env, &[sv::accept_governance(k.pubkey())], &[k]), e::UNAUTHORIZED);
    }
    // Stale proposals of the outgoing governance are pending at the handover...
    let (pa, pg) = (Keypair::new(), Keypair::new());
    run(&mut env, &[sv::propose_attestor(gov.pubkey(), pa.pubkey()), sv::propose_guardian(gov.pubkey(), pg.pubkey())], &[&gov]);
    run(&mut env, &[sv::cancel_attestor_proposal(grd.pubkey())], &[&grd]); // veto flag set
    run(&mut env, &[sv::propose_attestor(gov.pubkey(), pa.pubkey())], &[&gov]);
    let m = run(&mut env, &[sv::accept_governance(new_gov.pubkey())], &[&new_gov]);
    // ...and are all cleared by it (review finding R1).
    let c = env.config();
    assert_eq!((c.governance, c.pending_governance, c.pending_governance_eta), (new_gov.pubkey(), Address::default(), 0));
    assert_eq!((c.pending_attestor, c.pending_attestor_eta, c.pending_guardian, c.pending_guardian_eta), (Address::default(), 0, Address::default(), 0));
    assert_eq!(c.flags, 0);
    let ev = program_events(&m, "AdminChanged");
    assert_eq!(ev[0][1], vec![5]);
    assert_eq!((ev[0][3].clone(), ev[0][4].clone()), (pa.pubkey().as_ref().to_vec(), pg.pubkey().as_ref().to_vec()), "cleared proposals in the event");
    // The old governance lost every power; the new one has them.
    for ix in [sv::set_paused(gov.pubkey(), 1), sv::propose_attestor(gov.pubkey(), stranger.pubkey()), sv::propose_governance(gov.pubkey(), stranger.pubkey())] {
        expect_custom(&fails_no_change(&mut env, &[ix], &[&gov]), e::UNAUTHORIZED);
    }
    run(&mut env, &[sv::set_paused(new_gov.pubkey(), 1)], &[&new_gov]);
}

/// Review finding R1: a governance proposal can be withdrawn (zero key) and expires 30 days after its eta.
#[test]
fn adm07b_governance_proposal_withdraw_and_expiry() {
    let mut env = Env::initialized();
    let Keys { gov, grd, .. } = keys(&env);
    let wrong = Keypair::new();
    run(&mut env, &[sv::propose_governance(gov.pubkey(), wrong.pubkey())], &[&gov]);
    // The guardian cannot withdraw governance's own handover.
    expect_custom(&fails_no_change(&mut env, &[sv::propose_governance(grd.pubkey(), Address::default())], &[&grd]), e::UNAUTHORIZED);
    let m = run(&mut env, &[sv::propose_governance(gov.pubkey(), Address::default())], &[&gov]);
    let ev = program_events(&m, "AdminChanged");
    assert_eq!((ev[0][1].clone(), ev[0][2].clone()), (vec![9], wrong.pubkey().as_ref().to_vec()));
    assert_eq!(env.config().pending_governance, Address::default());
    expect_custom(&fails_no_change(&mut env, &[sv::accept_governance(wrong.pubkey())], &[&wrong]), e::NO_PENDING_GOVERNANCE);
    // Expiry: acceptable in [eta, eta + 30 d).
    run(&mut env, &[sv::propose_governance(gov.pubkey(), wrong.pubkey())], &[&gov]);
    let eta = env.config().pending_governance_eta;
    env.set_time(eta + sv::GOVERNANCE_ACCEPT_WINDOW);
    expect_custom(&fails_no_change(&mut env, &[sv::accept_governance(wrong.pubkey())], &[&wrong]), e::PROPOSAL_EXPIRED);
    // Re-proposing renews it.
    run(&mut env, &[sv::propose_governance(gov.pubkey(), wrong.pubkey())], &[&gov]);
    env.warp(sv::GOVERNANCE_ACCEPT_WINDOW - 1);
    run(&mut env, &[sv::accept_governance(wrong.pubkey())], &[&wrong]);
    assert_eq!(env.config().governance, wrong.pubkey());
}

/// Review findings R1/R2-A1: governance recovery by the guardian for a lost governance key: 30-day delay, governance
/// can withdraw or replace it at any time; the guardian can withdraw only its own proposal.
#[test]
fn adm07c_governance_recovery_by_the_guardian() {
    let mut env = Env::initialized();
    let Keys { att, gov, grd } = keys(&env);
    let rec = Keypair::new();
    let t = env.now();
    for bad in [att.pubkey(), grd.pubkey(), gov.pubkey()] {
        expect_custom(&fails_no_change(&mut env, &[sv::propose_governance(grd.pubkey(), bad)], &[&grd]), e::INVALID_AUTHORITY_KEY);
    }
    let m = run(&mut env, &[sv::propose_governance(grd.pubkey(), rec.pubkey())], &[&grd]);
    let ev = program_events(&m, "AdminChanged");
    assert_eq!((ev[0][1].clone(), ev[0][4].clone()), (vec![4], vec![role::GUARDIAN]));
    let c = env.config();
    assert_eq!((c.pending_governance, c.pending_governance_eta, c.flags), (rec.pubkey(), t + sv::RECOVERY_DELAY, sv::FLAG_GOVERNANCE_BY_GUARDIAN));
    // Not before the delay.
    expect_custom(&fails_no_change(&mut env, &[sv::accept_governance(rec.pubkey())], &[&rec]), e::ROTATION_NOT_READY);
    env.set_time(t + sv::RECOVERY_DELAY - 1);
    expect_custom(&fails_no_change(&mut env, &[sv::accept_governance(rec.pubkey())], &[&rec]), e::ROTATION_NOT_READY);
    // A live governance can withdraw it at any time.
    run(&mut env, &[sv::propose_governance(gov.pubkey(), Address::default())], &[&gov]);
    assert_eq!((env.config().pending_governance, env.config().flags), (Address::default(), 0));
    // The guardian can withdraw its own proposal; a governance handover overwrites it.
    run(&mut env, &[sv::propose_governance(grd.pubkey(), rec.pubkey())], &[&grd]);
    run(&mut env, &[sv::propose_governance(grd.pubkey(), Address::default())], &[&grd]);
    run(&mut env, &[sv::propose_governance(grd.pubkey(), rec.pubkey())], &[&grd]);
    let g2 = Keypair::new();
    run(&mut env, &[sv::propose_governance(gov.pubkey(), g2.pubkey())], &[&gov]);
    assert_eq!((env.config().pending_governance, env.config().flags), (g2.pubkey(), 0));
    expect_custom(&fails_no_change(&mut env, &[sv::propose_governance(grd.pubkey(), Address::default())], &[&grd]), e::UNAUTHORIZED);
    run(&mut env, &[sv::propose_governance(gov.pubkey(), Address::default())], &[&gov]);
    // Lost governance: nobody withdraws, the recovery key accepts after 30 days and takes over.
    run(&mut env, &[sv::propose_governance(grd.pubkey(), rec.pubkey())], &[&grd]);
    let eta = env.config().pending_governance_eta;
    env.set_time(eta);
    run(&mut env, &[sv::accept_governance(rec.pubkey())], &[&rec]);
    let c = env.config();
    assert_eq!((c.governance, c.flags, c.pending_governance), (rec.pubkey(), 0, Address::default()));
    expect_custom(&fails_no_change(&mut env, &[sv::set_paused(gov.pubkey(), 1)], &[&gov]), e::UNAUTHORIZED);
    // The recovered governance can rotate the attestor (with the guardian's consent).
    let a2 = Keypair::new();
    run(&mut env, &[sv::propose_attestor(rec.pubkey(), a2.pubkey()), sv::accept_attestor(grd.pubkey())], &[&rec, &grd]);
    assert_eq!(env.config().attestor, a2.pubkey());
}

/// Edge: attestor, governance and guardian can never end up being the same key, whatever the order of rotations.
#[test]
fn adm08_authority_keys_stay_distinct() {
    let mut env = Env::initialized();
    let Keys { gov, grd, .. } = keys(&env);
    let x = Keypair::new();
    // Propose x as attestor and as guardian, then hand governance to x: applying either proposal must now fail...
    // (the handover clears them anyway, so re-propose them under the new governance)
    run(&mut env, &[sv::propose_governance(gov.pubkey(), x.pubkey())], &[&gov]);
    let y = Keypair::new();
    run(&mut env, &[sv::propose_attestor(gov.pubkey(), y.pubkey()), sv::propose_guardian(gov.pubkey(), y.pubkey())], &[&gov]);
    // Applying the attestor proposal makes y the attestor; the guardian proposal for the same key must then fail.
    run(&mut env, &[sv::accept_attestor(grd.pubkey())], &[&grd]);
    expect_custom(&fails_no_change(&mut env, &[sv::accept_guardian(grd.pubkey())], &[&grd]), e::INVALID_AUTHORITY_KEY);
    // A pending governance key that became the attestor cannot accept governance.
    run(&mut env, &[sv::propose_governance(gov.pubkey(), Address::default())], &[&gov]);
    let z = Keypair::new();
    run(&mut env, &[sv::propose_governance(gov.pubkey(), z.pubkey()), sv::propose_attestor(gov.pubkey(), z.pubkey())], &[&gov]);
    run(&mut env, &[sv::accept_attestor(grd.pubkey())], &[&grd]);
    expect_custom(&fails_no_change(&mut env, &[sv::accept_governance(z.pubkey())], &[&z]), e::UNAUTHORIZED);
    // And a guardian proposal for the future governance key fails once that key is governance.
    let w = Keypair::new();
    run(&mut env, &[sv::propose_guardian(gov.pubkey(), w.pubkey()), sv::propose_governance(gov.pubkey(), w.pubkey())], &[&gov]);
    // The handover clears the guardian proposal (so nothing to apply) ...
    run(&mut env, &[sv::accept_governance(w.pubkey())], &[&w]);
    expect_custom(&fails_no_change(&mut env, &[sv::accept_guardian(grd.pubkey())], &[&grd]), e::NO_PENDING_ROTATION);
    let c = env.config();
    assert!(c.attestor != c.governance && c.attestor != c.guardian && c.guardian != c.governance);
    let _ = x;
}

#[test]
fn adm09_bad_data_and_fake_config() {
    let mut env = Env::initialized();
    let Keys { gov, .. } = keys(&env);
    for mut ix in [sv::propose_attestor(gov.pubkey(), Keypair::new().pubkey()), sv::propose_guardian(gov.pubkey(), Keypair::new().pubkey())] {
        ix.data.pop();
        expect_custom(&fails_no_change(&mut env, &[ix], &[&gov]), e::INVALID_INSTRUCTION);
    }
    for mut ix in [
        sv::accept_attestor(gov.pubkey()),
        sv::cancel_attestor_proposal(gov.pubkey()),
        sv::accept_governance(gov.pubkey()),
        sv::accept_guardian(gov.pubkey()),
        sv::cancel_guardian_proposal(gov.pubkey()),
    ] {
        ix.data.push(0);
        expect_custom(&fails_no_change(&mut env, &[ix], &[&gov]), e::INVALID_INSTRUCTION);
    }
    // A system-owned copy of Config.
    let real = env.account(&cfg_key()).unwrap();
    let k = Address::new_unique();
    env.svm.set_account(k, solana_account::Account { owner: sv::SYSTEM, ..real }).unwrap();
    let mut ix = sv::set_paused(gov.pubkey(), 1);
    ix.accounts[1].pubkey = k;
    expect_custom(&fails_no_change(&mut env, &[ix], &[&gov]), e::INVALID_CONFIG);
    let mut ix = sv::set_paused(gov.pubkey(), 1);
    ix.accounts.truncate(1);
    expect_ix(&fails_no_change(&mut env, &[ix], &[&gov]), InstructionError::NotEnoughAccountKeys);
}

/// Guardian rotation: consent by the current guardian, or anyone after 7 days; the old guardian loses every power.
/// A guardian change does not start a probation (only attestor changes do).
#[test]
fn adm10_guardian_rotation() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let Keys { gov, grd: old, .. } = keys(&env);
    let g2 = Keypair::new();
    run(&mut env, &[sv::propose_guardian(gov.pubkey(), g2.pubkey()), sv::accept_guardian(old.pubkey())], &[&gov, &old]);
    let c = env.config();
    assert_eq!((c.guardian, c.pending_guardian, c.probation_until), (g2.pubkey(), Address::default(), 0));
    // The old guardian has no power left.
    let claimant = env.funded(1);
    ok(env.request_claim(&l.ph, &claimant, 1));
    let cranker = env.cranker.insecure_clone();
    expect_custom(&env.send(&[sv::cancel_claim(old.pubkey(), &l.ph)], &cranker, &[&old]), e::UNAUTHORIZED);
    for ix in [sv::set_paused(old.pubkey(), 1), sv::cancel_attestor_proposal(old.pubkey()), sv::propose_governance(old.pubkey(), Keypair::new().pubkey())] {
        expect_custom(&fails_no_change(&mut env, &[ix], &[&old]), e::UNAUTHORIZED);
    }
    ok(env.send(&[sv::cancel_claim(g2.pubkey(), &l.ph)], &cranker, &[&g2]));
    // Lost guardian: governance proposes, anyone applies after 7 days.
    let g3 = Keypair::new();
    run(&mut env, &[sv::propose_guardian(gov.pubkey(), g3.pubkey())], &[&gov]);
    let eta = env.config().pending_guardian_eta;
    expect_custom(&fails_no_change(&mut env, &[sv::accept_guardian(old.pubkey())], &[&old]), e::ROTATION_NOT_READY);
    env.set_time(eta);
    let stranger = Keypair::new();
    run(&mut env, &[sv::accept_guardian(stranger.pubkey())], &[&stranger]);
    assert_eq!(env.config().guardian, g3.pubkey());
    assert_eq!(env.config().probation_until, 0);
}
