//! WDR-*: owner withdraw (repeatable, never below rent), non-owner rejection, and "no admin path drains funds"
//! (SPEC §5.6, invariants I1/I2/I8).
#![allow(clippy::result_large_err, deprecated)]
mod common;

use common::*;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;

const PLACE: &str = "ChIJN1t_tDeuEmsRUsoyG83frY4";

fn donate(env: &mut Env, to: &Address, lamports: u64) {
    let donor = env.funded(lamports / LAMPORTS_PER_SOL + 2);
    ok(env.send(&[system_transfer(donor.pubkey(), *to, lamports)], &donor, &[]));
}

#[track_caller]
fn fails_no_change(env: &mut Env, ph: &[u8; 32], ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) -> TxResult {
    let keys = [sv::state_pda(ph).0, sv::vault_pda(ph).0, sv::config_pda().0];
    let before = env.snapshot(&keys);
    let r = env.send(ixs, payer, extra);
    assert!(r.is_err(), "expected failure");
    assert_eq!(env.snapshot(&keys), before, "failed withdraw changed state");
    r
}

fn owned_shop() -> (Env, Launched, Keypair) {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let owner = env.claim_and_finalize(&l.ph);
    (env, l, owner)
}

#[test]
fn wdr01_pays_vault_and_state_surplus_down_to_rent() {
    let (mut env, l, owner) = owned_shop();
    donate(&mut env, &l.vault, 3 * LAMPORTS_PER_SOL);
    donate(&mut env, &l.state, LAMPORTS_PER_SOL / 2); // stray SOL sent to the state PDA
    let before = env.lamports(&owner.pubkey());
    let cranker = env.cranker.insecure_clone();
    let m = ok(env.send(&[sv::withdraw(owner.pubkey(), &l.ph)], &cranker, &[&owner]));
    let paid = 3 * LAMPORTS_PER_SOL + LAMPORTS_PER_SOL / 2;
    assert_eq!(env.lamports(&owner.pubkey()) - before, paid);
    assert_eq!(env.lamports(&l.vault), env.rent(0), "vault ends at exactly rent_min(0)");
    assert_eq!(env.lamports(&l.state), env.rent(208), "state ends at exactly rent_min(208)");
    assert_eq!(env.account(&l.vault).unwrap().owner, sv::SYSTEM);
    let st = env.state(&l.ph);
    assert_eq!(st.total_withdrawn, paid);
    let ev = program_events(&m, "Withdrawn");
    assert_eq!(ev[0][1], l.ph.to_vec());
    assert_eq!(ev[0][2], owner.pubkey().as_ref().to_vec());
    assert_eq!(ev[0][3], paid.to_le_bytes().to_vec());
    assert_eq!(ev[0][4], paid.to_le_bytes().to_vec());
    let cu = shop_vault_cu(&m)[0];
    println!("withdraw CU {cu}");
    assert!(cu <= 8_000, "withdraw CU {cu}");
}

#[test]
fn wdr02_repeatable_pays_only_the_delta() {
    let (mut env, l, owner) = owned_shop();
    let trader = env.funded(50);
    let cranker = env.cranker.insecure_clone();
    let mut total = 0;
    for round in 1..=3u64 {
        let evs = env.buy_v3(&trader, &l.mint, round * LAMPORTS_PER_SOL);
        env.sweep_and_collect(&l.mint, &l.vault);
        let fee: u64 = evs.iter().map(|e| e.creator_fee).sum();
        let before = env.lamports(&owner.pubkey());
        ok(env.send(&[sv::withdraw(owner.pubkey(), &l.ph)], &cranker, &[&owner]));
        assert_eq!(env.lamports(&owner.pubkey()) - before, fee, "round {round} pays only the new fees");
        assert_eq!(env.lamports(&l.vault), env.rent(0));
        total += fee;
        assert_eq!(env.state(&l.ph).total_withdrawn, total);
    }
}

#[test]
fn wdr03_nothing_to_withdraw() {
    let (mut env, l, owner) = owned_shop();
    let r = fails_no_change(&mut env, &l.ph, &[sv::withdraw(owner.pubkey(), &l.ph)], &owner, &[]);
    expect_custom(&r, e::NOTHING_TO_WITHDRAW);
    // After a full withdraw, again nothing.
    donate(&mut env, &l.vault, LAMPORTS_PER_SOL);
    ok(env.send(&[sv::withdraw(owner.pubkey(), &l.ph)], &owner, &[]));
    let r = fails_no_change(&mut env, &l.ph, &[sv::withdraw(owner.pubkey(), &l.ph)], &owner, &[]);
    expect_custom(&r, e::NOTHING_TO_WITHDRAW);
}

#[test]
fn wdr04_non_owner_rejected() {
    // No owner yet: even the launcher, attestor, governance and the upgrade authority get NoOwner.
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    donate(&mut env, &l.vault, LAMPORTS_PER_SOL);
    let who: Vec<Keypair> = vec![
        l.launcher.insecure_clone(),
        env.attestor.insecure_clone(),
        env.governance.insecure_clone(),
        env.deployer.insecure_clone(),
        env.cranker.insecure_clone(),
    ];
    for k in &who {
        env.fund(&k.pubkey(), LAMPORTS_PER_SOL);
        let r = fails_no_change(&mut env, &l.ph, &[sv::withdraw(k.pubkey(), &l.ph)], k, &[]);
        expect_custom(&r, e::NO_OWNER);
    }
    // With an owner: everyone else gets NotOwner.
    let owner = env.claim_and_finalize(&l.ph);
    for k in &who {
        let r = fails_no_change(&mut env, &l.ph, &[sv::withdraw(k.pubkey(), &l.ph)], k, &[]);
        expect_custom(&r, e::NOT_OWNER);
    }
    // A stranger naming the owner's account without the owner's signature.
    let stranger = env.funded(1);
    let mut ix = sv::withdraw(owner.pubkey(), &l.ph);
    ix.accounts[0].is_signer = false;
    let r = fails_no_change(&mut env, &l.ph, &[ix], &stranger, &[]);
    expect_ix(&r, InstructionError::MissingRequiredSignature);
    // Owner signs but is read-only.
    let mut ix = sv::withdraw(owner.pubkey(), &l.ph);
    ix.accounts[0].is_writable = false;
    let r = fails_no_change(&mut env, &l.ph, &[ix], &stranger, &[&owner]);
    expect_custom(&r, e::ACCOUNT_NOT_WRITABLE);
    // The owner works.
    ok(env.send(&[sv::withdraw(owner.pubkey(), &l.ph)], &stranger, &[&owner]));
}

#[test]
fn wdr05_wrong_vault() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let other = env.launch("other-place", 0);
    let owner = env.claim_and_finalize(&l.ph);
    let other_owner = env.claim_and_finalize(&other.ph);
    donate(&mut env, &l.vault, LAMPORTS_PER_SOL);
    donate(&mut env, &other.vault, 2 * LAMPORTS_PER_SOL);
    let rand_sys = Address::new_unique();
    env.svm.set_account(rand_sys, Account { lamports: 5 * LAMPORTS_PER_SOL, data: vec![], owner: sv::SYSTEM, executable: false, rent_epoch: 0 }).unwrap();
    for bad in [other.vault, rand_sys, l.state, other.state] {
        let mut ix = sv::withdraw(owner.pubkey(), &l.ph);
        ix.accounts[2].pubkey = bad;
        let r = fails_no_change(&mut env, &l.ph, &[ix], &owner, &[]);
        expect_custom(&r, e::INVALID_VAULT);
    }
    // Read-only vault.
    let mut ix = sv::withdraw(owner.pubkey(), &l.ph);
    ix.accounts[2].is_writable = false;
    let r = fails_no_change(&mut env, &l.ph, &[ix], &owner, &[]);
    expect_custom(&r, e::INVALID_VAULT);
    // The other place's owner with this place's state.
    let mut ix = sv::withdraw(other_owner.pubkey(), &other.ph);
    ix.accounts[1].pubkey = l.state;
    let r = fails_no_change(&mut env, &l.ph, &[ix], &other_owner, &[]);
    expect_custom(&r, e::NOT_OWNER);
    assert_eq!(env.lamports(&other.vault), env.rent(0) + 2 * LAMPORTS_PER_SOL);
}

#[test]
fn wdr06_atomic_sweep_collect_withdraw() {
    let (mut env, l, owner) = owned_shop();
    let trader = env.funded(50);
    let evs = env.buy_v3(&trader, &l.mint, 3 * LAMPORTS_PER_SOL);
    let fee: u64 = evs.iter().map(|e| e.creator_fee).sum();
    let before = env.lamports(&owner.pubkey());
    let cranker = env.cranker.insecure_clone();
    let ixs = vec![
        cu_limit(200_000),
        sweep_creator_fee(cranker.pubkey(), l.mint, l.vault),
        collect_creator_fee(l.vault),
        sv::withdraw(owner.pubkey(), &l.ph),
    ];
    ok(env.send(&ixs, &cranker, &[&owner]));
    assert_eq!(env.lamports(&owner.pubkey()) - before, fee);
    assert_eq!(env.lamports(&l.vault), env.rent(0));
}

#[test]
fn wdr07_relayer_pays_for_an_owner_with_zero_sol() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let owner = Keypair::new(); // never funded
    let attestor = env.attestor.insecure_clone();
    let relayer = env.funded(2);
    ok(env.send(&[sv::request_claim(attestor.pubkey(), owner.pubkey(), &l.ph, 1)], &relayer, &[&attestor, &owner]));
    let unlock = env.state(&l.ph).unlock_ts;
    env.set_time(unlock);
    ok(env.send(&[sv::finalize_claim(&l.ph)], &relayer, &[]));
    donate(&mut env, &l.vault, LAMPORTS_PER_SOL);
    assert_eq!(env.lamports(&owner.pubkey()), 0);
    ok(env.send(&[sv::withdraw(owner.pubkey(), &l.ph)], &relayer, &[&owner]));
    assert_eq!(env.lamports(&owner.pubkey()), LAMPORTS_PER_SOL);
}

#[test]
fn wdr08_fake_system_program() {
    let (mut env, l, owner) = owned_shop();
    donate(&mut env, &l.vault, LAMPORTS_PER_SOL);
    let mut ix = sv::withdraw(owner.pubkey(), &l.ph);
    ix.accounts[3].pubkey = SPL_TOKEN;
    let r = fails_no_change(&mut env, &l.ph, &[ix], &owner, &[]);
    expect_custom(&r, e::INVALID_SYSTEM_PROGRAM);
}

#[test]
fn wdr09_total_withdrawn_overflow() {
    let (mut env, l, owner) = owned_shop();
    donate(&mut env, &l.vault, LAMPORTS_PER_SOL);
    let mut acc = env.account(&l.state).unwrap();
    acc.data[184..192].copy_from_slice(&(u64::MAX - 10).to_le_bytes());
    env.svm.set_account(l.state, acc).unwrap();
    let r = fails_no_change(&mut env, &l.ph, &[sv::withdraw(owner.pubkey(), &l.ph)], &owner, &[]);
    expect_custom(&r, e::ARITHMETIC_OVERFLOW);
    assert_eq!(env.lamports(&l.vault), env.rent(0) + LAMPORTS_PER_SOL);
}

#[test]
fn wdr10_works_while_paused_and_with_a_pending_claim() {
    let (mut env, l, owner) = owned_shop();
    let gov = env.governance.insecure_clone();
    let cranker = env.cranker.insecure_clone();
    ok(env.send(&[sv::set_paused(gov.pubkey(), 1)], &cranker, &[&gov]));
    let b = env.funded(1);
    ok(env.request_claim(&l.ph, &b, 2));
    donate(&mut env, &l.vault, LAMPORTS_PER_SOL);
    let before = env.lamports(&owner.pubkey());
    ok(env.send(&[sv::withdraw(owner.pubkey(), &l.ph)], &cranker, &[&owner]));
    assert_eq!(env.lamports(&owner.pubkey()) - before, LAMPORTS_PER_SOL);
}

/// No admin path drains funds: every admin instruction, the upgrade authority, the attestor and governance leave
/// vault and state lamports untouched; only the owner can withdraw, and only to itself (I1, I2, I8).
#[test]
fn wdr11_no_admin_path_moves_funds() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let owner = env.claim_and_finalize(&l.ph);
    donate(&mut env, &l.vault, 5 * LAMPORTS_PER_SOL);
    donate(&mut env, &l.state, LAMPORTS_PER_SOL);
    let vault0 = env.lamports(&l.vault);
    let state0 = env.lamports(&l.state);
    let attestor = env.attestor.insecure_clone();
    let gov = env.governance.insecure_clone();
    let grd = env.guardian.insecure_clone();
    let new_att = Keypair::new();
    let new_gov = Keypair::new();
    let new_grd = Keypair::new();
    let cranker = env.cranker.insecure_clone();
    env.fund(&new_gov.pubkey(), LAMPORTS_PER_SOL);
    let steps: Vec<(Vec<Instruction>, Vec<&Keypair>)> = vec![
        (vec![sv::set_paused(grd.pubkey(), 1)], vec![&grd]),
        (vec![sv::set_paused(gov.pubkey(), 0)], vec![&gov]),
        (vec![sv::propose_attestor(gov.pubkey(), new_att.pubkey())], vec![&gov]),
        (vec![sv::cancel_attestor_proposal(grd.pubkey())], vec![&grd]),
        (vec![sv::propose_attestor(gov.pubkey(), new_att.pubkey()), sv::accept_attestor(grd.pubkey())], vec![&gov, &grd]),
        (vec![sv::propose_guardian(gov.pubkey(), new_grd.pubkey()), sv::accept_guardian(grd.pubkey())], vec![&gov, &grd]),
        (vec![sv::propose_governance(new_grd.pubkey(), Keypair::new().pubkey())], vec![&new_grd]),
        (vec![sv::propose_governance(gov.pubkey(), new_gov.pubkey())], vec![&gov]),
        (vec![sv::accept_governance(new_gov.pubkey())], vec![&new_gov]),
    ];
    for (ixs, signers) in steps {
        ok(env.send(&ixs, &cranker, &signers));
        assert_eq!(env.lamports(&l.vault), vault0);
        assert_eq!(env.lamports(&l.state), state0);
    }
    // Every privileged key tries to withdraw, naming itself as the recipient, or naming the owner without its
    // signature: all fail and nothing moves.
    for k in [&attestor, &gov, &grd, &new_att, &new_gov, &new_grd, &env.deployer.insecure_clone(), &l.launcher.insecure_clone()] {
        env.fund(&k.pubkey(), LAMPORTS_PER_SOL);
        let r = fails_no_change(&mut env, &l.ph, &[sv::withdraw(k.pubkey(), &l.ph)], k, &[]);
        expect_custom(&r, e::NOT_OWNER);
        let mut ix = sv::withdraw(owner.pubkey(), &l.ph);
        ix.accounts[0].is_signer = false;
        let r = fails_no_change(&mut env, &l.ph, &[ix], k, &[]);
        expect_ix(&r, InstructionError::MissingRequiredSignature);
    }
    // Admin instructions pointed at a VaultState instead of Config are refused (they never touch VaultState).
    for ix in [sv::set_paused(new_grd.pubkey(), 1), sv::propose_attestor(new_gov.pubkey(), Address::new_unique())] {
        let mut ix = ix;
        ix.accounts[1].pubkey = l.state;
        let signer = if ix.data[0] == 7 { &new_grd } else { &new_gov };
        let r = fails_no_change(&mut env, &l.ph, &[ix], &cranker, &[signer]);
        expect_custom(&r, e::INVALID_CONFIG);
    }
    // Only the owner gets the money, all of it above rent.
    let before = env.lamports(&owner.pubkey());
    ok(env.send(&[sv::withdraw(owner.pubkey(), &l.ph)], &cranker, &[&owner]));
    assert_eq!(env.lamports(&owner.pubkey()) - before, (vault0 - env.rent(0)) + (state0 - env.rent(208)));
}

#[test]
fn wdr12_bad_instruction_data() {
    let (mut env, l, owner) = owned_shop();
    donate(&mut env, &l.vault, LAMPORTS_PER_SOL);
    let mut ix = sv::withdraw(owner.pubkey(), &l.ph);
    ix.data.push(1);
    let r = fails_no_change(&mut env, &l.ph, &[ix], &owner, &[]);
    expect_custom(&r, e::INVALID_INSTRUCTION);
    let mut ix = sv::withdraw(owner.pubkey(), &l.ph);
    ix.accounts.truncate(3);
    let r = fails_no_change(&mut env, &l.ph, &[ix], &owner, &[]);
    expect_ix(&r, InstructionError::NotEnoughAccountKeys);
}
