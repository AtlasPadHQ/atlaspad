//! FEE-*: the D1 proof. Real pump.fun trades, permissionless sweep + collect into the system-owned ShopVault, then
//! the owner withdraws exactly that amount (SPEC §4, §13.3).
#![allow(clippy::result_large_err, deprecated)]
mod common;

use common::*;
use solana_account::Account;
use solana_address::Address;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;

const PLACE: &str = "ChIJN1t_tDeuEmsRUsoyG83frY4";

fn sum_creator_fees(evs: &[TradeEvent]) -> u64 {
    evs.iter().map(|e| e.creator_fee).sum()
}

/// FEE-01: v3 buys and sells → bucket > 0 → sweep → collect(creator = vault) by a stranger → vault delta ==
/// Σ TradeEvent.creator_fee; the vault stays system-owned with 0 data; withdraw pays exactly that delta.
#[test]
fn fee01_v3_trades_sweep_collect_lands_in_system_owned_vault() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let launch_events = trade_events(&l.meta);
    assert!(launch_events.is_empty());
    let vault0 = env.lamports(&l.vault);
    assert_eq!(vault0, env.rent(0));

    let trader = env.funded(50);
    let mut evs = vec![];
    evs.extend(env.buy_v3(&trader, &l.mint, 2 * LAMPORTS_PER_SOL));
    evs.extend(env.buy_v3(&trader, &l.mint, LAMPORTS_PER_SOL / 3));
    let bal = env.token_balance(&trader.pubkey(), &l.mint);
    evs.extend(env.sell_v3(&trader, &l.mint, bal / 2));
    assert_eq!(evs.len(), 3);
    for ev in &evs {
        assert_eq!(ev.mint, l.mint);
        assert_eq!(ev.creator, l.vault, "pump reports our vault as the creator");
        assert!(ev.creator_fee > 0);
    }
    let expected = sum_creator_fees(&evs);
    let bucket = env.curve(&l.mint).creator_fee_bucket;
    println!("FEE-01: Σ creator_fee = {expected} lamports, curve bucket = {bucket}");
    assert_eq!(bucket, expected, "v3 trades leave the creator fee on the curve");
    assert_eq!(env.lamports(&l.vault), vault0, "nothing reaches the vault before the sweep");

    // A stranger (the cranker) sweeps and collects; nobody from the shop signs.
    let m = env.sweep_and_collect(&l.mint, &l.vault);
    println!("FEE-01 sweep+collect CU {}", m.compute_units_consumed);
    let delta = env.lamports(&l.vault) - vault0;
    assert_eq!(delta, expected, "vault delta == Σ creator fees");
    assert_eq!(env.curve(&l.mint).creator_fee_bucket, 0);
    let va = env.account(&l.vault).unwrap();
    assert_eq!(va.owner, sv::SYSTEM, "vault still system-owned");
    assert!(va.data.is_empty(), "vault still has no data");
    // creator_vault keeps only its rent floor.
    assert!(env.lamports(&creator_vault(&l.vault)) <= env.rent(0));

    // Owner claims, then withdraws exactly the collected fees; the vault keeps rent_min(0).
    let owner = env.claim_and_finalize(&l.ph);
    let before = env.lamports(&owner.pubkey());
    let cranker = env.cranker.insecure_clone();
    let m = ok(env.send(&[sv::withdraw(owner.pubkey(), &l.ph)], &cranker, &[&owner]));
    assert_eq!(env.lamports(&owner.pubkey()) - before, expected);
    assert_eq!(env.lamports(&l.vault), env.rent(0));
    assert_eq!(env.state(&l.ph).total_withdrawn, expected);
    let ev = program_events(&m, "Withdrawn");
    assert_eq!(u64::from_le_bytes(ev[0][3].clone().try_into().unwrap()), expected);
}

/// FEE-01 with the dev buy inside the launch tx: its creator fee is collected too.
#[test]
fn fee01b_dev_buy_fee_is_collected() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 100_000_000);
    let evs = trade_events(&l.meta);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].creator, l.vault);
    let vault0 = env.lamports(&l.vault);
    env.sweep_and_collect(&l.mint, &l.vault);
    assert_eq!(env.lamports(&l.vault) - vault0, evs[0].creator_fee);
}

/// FEE-02: v2 trades pay the pump creator_vault directly; collect moves it into our vault.
#[test]
fn fee02_v2_trades_collect_lands_in_vault() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let vault0 = env.lamports(&l.vault);
    let trader = env.funded(50);
    let mut evs = vec![];
    // buy_v2 takes a token amount and a max cost.
    evs.extend(env.buy_v2(&trader, &l.mint, &l.vault, 20_000_000_000_000, 5 * LAMPORTS_PER_SOL));
    let bal = env.token_balance(&trader.pubkey(), &l.mint);
    assert_eq!(bal, 20_000_000_000_000);
    evs.extend(env.sell_v2(&trader, &l.mint, &l.vault, bal / 4));
    assert_eq!(evs.len(), 2);
    let expected = sum_creator_fees(&evs);
    assert!(expected > 0);
    assert_eq!(env.curve(&l.mint).creator_fee_bucket, 0, "v2 trades do not use the bucket");
    let cv = creator_vault(&l.vault);
    let cv_bal = env.lamports(&cv);
    println!("FEE-02: Σ creator_fee = {expected}, creator_vault = {cv_bal} (rent {})", env.rent(0));
    // The first v2 trade also funds the creator vault's rent floor (paid by the trader, never collectable).
    assert_eq!(cv_bal, expected + env.rent(0), "v2 pays the creator vault directly");

    // collect alone (no sweep needed), by a stranger.
    let cranker = env.cranker.insecure_clone();
    ok(env.send(&[collect_creator_fee(l.vault)], &cranker, &[]));
    assert_eq!(env.lamports(&l.vault) - vault0, expected);
    assert_eq!(env.account(&l.vault).unwrap().owner, sv::SYSTEM);

    // Mixed: more v3 + v2 trades then one sweep+collect.
    let mut evs2 = env.buy_v3(&trader, &l.mint, LAMPORTS_PER_SOL);
    evs2.extend(env.buy_v2(&trader, &l.mint, &l.vault, 1_000_000_000_000, 2 * LAMPORTS_PER_SOL));
    let v1 = env.lamports(&l.vault);
    env.sweep_and_collect(&l.mint, &l.vault);
    assert_eq!(env.lamports(&l.vault) - v1, sum_creator_fees(&evs2));
}

/// FEE-03 (informational): creator = a program-owned data account. Records whether pump would have paid it.
#[test]
fn fee03_control_program_owned_creator_is_recorded() {
    let mut env = Env::initialized();
    let creator = Address::new_unique();
    env.svm
        .set_account(creator, Account { lamports: env.rent(208), data: vec![7u8; 208], owner: PROGRAM_ID, executable: false, rent_epoch: 0 })
        .unwrap();
    let launcher = env.funded(5);
    let mint = Keypair::new();
    let create = env.send(&[cu_limit(400_000), create_v2(mint.pubkey(), launcher.pubkey(), &CreateArgs::sol(creator))], &launcher, &[&mint]);
    let create_ok = create.is_ok();
    let mut outcome = format!("create_v2: {}", if create_ok { "ok".into() } else { format!("{:?}", create.as_ref().unwrap_err().err) });
    if create_ok {
        let trader = env.funded(10);
        let evs = env.buy_v3(&trader, &mint.pubkey(), LAMPORTS_PER_SOL);
        let before = env.lamports(&creator);
        let cranker = env.cranker.insecure_clone();
        let r = env.send(
            &[cu_limit(200_000), sweep_creator_fee(cranker.pubkey(), mint.pubkey(), creator), collect_creator_fee(creator)],
            &cranker,
            &[],
        );
        match r {
            Ok(_) => outcome += &format!("; sweep+collect: ok, creator delta {} (Σ fee {})", env.lamports(&creator) - before, sum_creator_fees(&evs)),
            Err(f) => outcome += &format!("; sweep+collect: FAILED {:?}", f.err),
        }
    }
    println!("FEE-03 (program-owned data account as pump creator): {outcome}");
}

/// FEE-04: nobody can create a fee-sharing config for our coin (only the creator could, and the vault never signs).
#[test]
fn fee04_stranger_cannot_create_fee_sharing_config() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 10_000_000);
    let stranger = env.funded(5);
    let r = env.send(&[cu_limit(400_000), create_fee_sharing_config(stranger.pubkey(), l.mint)], &stranger, &[]);
    let (_, err) = ix_err(&r);
    println!("FEE-04 stranger create_fee_sharing_config: {err:?}");
    assert_eq!(err, InstructionError::Custom(6016), "pump_fees NotAuthorized\n{}", fail_str(r.as_ref().unwrap_err()));
    assert_eq!(env.curve(&l.mint).creator, l.vault);
    assert!(env.account(&sharing_config(&l.mint)).is_none());
}

/// FEE-05: `set_metaplex_creator` cannot change our coin's creator (no Metaplex metadata exists for a create_v2 mint).
#[test]
fn fee05_set_metaplex_creator_leaves_creator_unchanged() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 10_000_000);
    let stranger = env.funded(5);
    let r = env.send(&[set_metaplex_creator(l.mint)], &stranger, &[]);
    println!("FEE-05 set_metaplex_creator: {}", match &r { Ok(_) => "ok".to_string(), Err(f) => format!("{:?}", f.err) });
    assert_eq!(env.curve(&l.mint).creator, l.vault);
}

/// Fees keep accruing and collecting after a claim, and anyone can donate directly to the vault.
#[test]
fn fee06_collect_is_repeatable_and_donations_land() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let trader = env.funded(50);
    let mut total = 0;
    for i in 0..4 {
        let evs = env.buy_v3(&trader, &l.mint, (i + 1) * LAMPORTS_PER_SOL / 2);
        let v = env.lamports(&l.vault);
        env.sweep_and_collect(&l.mint, &l.vault);
        assert_eq!(env.lamports(&l.vault) - v, sum_creator_fees(&evs));
        total += sum_creator_fees(&evs);
    }
    // Collect with nothing to collect is harmless.
    let v = env.lamports(&l.vault);
    env.sweep_and_collect(&l.mint, &l.vault);
    assert_eq!(env.lamports(&l.vault), v);
    // A donation.
    let donor = env.funded(2);
    ok(env.send(&[system_transfer(donor.pubkey(), l.vault, 12_345)], &donor, &[]));
    assert_eq!(env.lamports(&l.vault), env.rent(0) + total + 12_345);
}
