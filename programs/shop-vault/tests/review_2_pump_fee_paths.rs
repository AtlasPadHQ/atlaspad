//! REVIEW-2 (adversarial): can anyone divert or starve the shop's creator fees through pump / pump-amm, using the
//! real mainnet `pump.so` / `pump_amm.so` fixtures? Every test here asserts the SAFE outcome; a failure would be a
//! demonstrated exploit. Probes:
//!   R2-P1  sweep_creator_fee with an attacker-chosen recipient (the IDL has no seeds constraint on `recipient`)
//!   R2-P2  collect_creator_fee with creator = attacker but creator_vault = our vault's creator vault
//!   R2-P3  legacy v1 buy / sell / buy_exact_sol_in (not covered by FEE-01/02) still pay our vault
//!   R2-P4  v1 sell with the cashback remaining accounts on our (non-cashback) coin cannot redirect the creator fee
//!   R2-P5  create_v2 with a non-default creator_fee_bps (Global.creator_fee_configurable = true on mainnet) is
//!          ignored for a SOL coin, so a launcher cannot register a coin that starves the shop
//!   R2-P6  the bucket left on a curve that has COMPLETED (graduation buy) is still sweepable into the vault
//!   R2-P7  pump-amm collect_coin_creator_fee (no signer) cannot push our graduated fees into an attacker account;
//!          into the vault's WSOL ATA it works and unwrap_wsol lands it in the vault (SPEC D7 premise)
#![allow(clippy::result_large_err, deprecated)]
mod common;

use common::*;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

const PLACE: &str = "ChIJN1t_tDeuEmsRUsoyG83frY4";

fn ro(a: Address) -> AccountMeta {
    AccountMeta::new_readonly(a, false)
}
fn w(a: Address) -> AccountMeta {
    AccountMeta::new(a, false)
}
fn ws(a: Address) -> AccountMeta {
    AccountMeta::new(a, true)
}

fn global_volume_accumulator() -> Address {
    pda(&[b"global_volume_accumulator"], &PUMP)
}
fn bonding_curve_v2(mint: &Address) -> Address {
    pda(&[b"bonding-curve-v2", mint.as_ref()], &PUMP)
}
fn amm_creator_vault_authority(creator: &Address) -> Address {
    pda(&[b"creator_vault", creator.as_ref()], &PUMP_AMM)
}
fn amm_event_authority() -> Address {
    pda(&[b"__event_authority"], &PUMP_AMM)
}

/// TradeEvent `creator_fee_basis_points` (offset 201 after the 16-byte emit_cpi tag + discriminator).
fn trade_creator_fee_bps(m: &litesvm::types::TransactionMetadata) -> Vec<u64> {
    m.inner_instructions
        .iter()
        .flatten()
        .filter(|ix| TradeEvent::try_decode(&ix.instruction.data).is_some())
        .map(|ix| u64::from_le_bytes(ix.instruction.data[16 + 201..16 + 209].try_into().unwrap()))
        .collect()
}

/// TradeEvent `cashback` (after the variable-length `ix_name` string).
fn trade_cashback(m: &litesvm::types::TransactionMetadata) -> Vec<u64> {
    m.inner_instructions
        .iter()
        .flatten()
        .filter(|ix| TradeEvent::try_decode(&ix.instruction.data).is_some())
        .map(|ix| {
            let d = &ix.instruction.data[16..];
            let o = 250; // ix_name string length prefix
            let n = u32::from_le_bytes(d[o..o + 4].try_into().unwrap()) as usize;
            let o = o + 4 + n + 1 /* mayhem_mode */ + 8 /* cashback_fee_basis_points */;
            u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
        })
        .collect()
}

/// Legacy v1 `buy(amount, max_sol_cost, track_volume, partial_fill)`.
fn buy_v1(user: Address, mint: Address, creator: Address, amount: u64, max_sol_cost: u64) -> Instruction {
    let curve = bonding_curve(&mint);
    let mut d = vec![0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea];
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&max_sol_cost.to_le_bytes());
    d.extend_from_slice(&[0, 0]);
    Instruction {
        program_id: PUMP,
        accounts: vec![
            ro(GLOBAL),
            w(FEE_RECIPIENT),
            ro(mint),
            w(curve),
            w(ata(&curve, &mint, &TOKEN_2022)),
            w(ata(&user, &mint, &TOKEN_2022)),
            ws(user),
            ro(SYSTEM),
            ro(TOKEN_2022),
            w(creator_vault(&creator)),
            ro(EVENT_AUTHORITY),
            ro(PUMP),
            ro(global_volume_accumulator()),
            w(user_volume_accumulator(&user)),
            ro(FEE_CONFIG),
            ro(PUMP_FEES),
            ro(bonding_curve_v2(&mint)),
            w(BUYBACK_RECIPIENT),
        ],
        data: d,
    }
}

/// Legacy v1 `buy_exact_sol_in(spendable_sol_in, min_tokens_out, track_volume, partial_fill)`.
fn buy_exact_sol_in_v1(user: Address, mint: Address, creator: Address, spend: u64) -> Instruction {
    let mut ix = buy_v1(user, mint, creator, 0, 0);
    let mut d = vec![0x38, 0xfc, 0x74, 0x08, 0x9e, 0xdf, 0xcd, 0x5f];
    d.extend_from_slice(&spend.to_le_bytes());
    d.extend_from_slice(&1u64.to_le_bytes());
    d.extend_from_slice(&[0, 0]);
    ix.data = d;
    ix
}

/// Legacy v1 `sell(amount, min_sol_output)` (+ optional remaining accounts).
fn sell_v1(user: Address, mint: Address, creator: Address, amount: u64, remaining: &[AccountMeta]) -> Instruction {
    let curve = bonding_curve(&mint);
    let mut d = vec![0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad];
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&0u64.to_le_bytes());
    let mut accounts = vec![
        ro(GLOBAL),
        w(FEE_RECIPIENT),
        ro(mint),
        w(curve),
        w(ata(&curve, &mint, &TOKEN_2022)),
        w(ata(&user, &mint, &TOKEN_2022)),
        ws(user),
        ro(SYSTEM),
        w(creator_vault(&creator)),
        ro(TOKEN_2022),
        ro(EVENT_AUTHORITY),
        ro(PUMP),
        ro(FEE_CONFIG),
        ro(PUMP_FEES),
    ];
    accounts.extend_from_slice(remaining);
    accounts.push(ro(bonding_curve_v2(&mint)));
    accounts.push(w(BUYBACK_RECIPIENT));
    Instruction { program_id: PUMP, accounts, data: d }
}

/// `sweep_creator_fee` with an arbitrary recipient (the SDK always passes `creator_vault(curve.creator)`).
fn sweep_to(payer: Address, mint: Address, recipient: Address) -> Instruction {
    let curve = bonding_curve(&mint);
    Instruction {
        program_id: PUMP,
        accounts: vec![
            ws(payer),
            ro(GLOBAL),
            ro(mint),
            ro(NATIVE_MINT),
            ro(SPL_TOKEN),
            ro(ATA_PROGRAM),
            ro(SYSTEM),
            w(curve),
            w(wsol_ata(&curve)),
            w(recipient),
            w(wsol_ata(&recipient)),
            ro(EVENT_AUTHORITY),
            ro(PUMP),
        ],
        data: vec![0x20, 0xf6, 0xbf, 0x34, 0x08, 0xc9, 0x49, 0xba],
    }
}

/// pump-amm `collect_coin_creator_fee` (no signer in IDL 3.2.0) with an arbitrary destination token account.
fn amm_collect_coin_creator_fee(coin_creator: Address, destination: Address) -> Instruction {
    let auth = amm_creator_vault_authority(&coin_creator);
    Instruction {
        program_id: PUMP_AMM,
        accounts: vec![
            ro(NATIVE_MINT),
            ro(SPL_TOKEN),
            ro(coin_creator),
            ro(auth),
            w(wsol_ata(&auth)),
            w(destination),
            ro(amm_event_authority()),
            ro(PUMP_AMM),
        ],
        data: vec![0xa0, 0x39, 0x59, 0x2a, 0xb5, 0x8b, 0x2b, 0x42],
    }
}

fn sync_native(account: Address) -> Instruction {
    Instruction { program_id: SPL_TOKEN, accounts: vec![w(account)], data: vec![17] }
}

/// Pump-side probe that must FAIL: the bucket / creator vault / vault balances must be unchanged.
#[track_caller]
fn must_fail(env: &mut Env, ixs: &[Instruction], payer: &Keypair, watch: &[Address], what: &str) {
    let before = env.snapshot(watch);
    let r = env.send(ixs, payer, &[]);
    match &r {
        Ok(m) => panic!("EXPLOIT: {what} succeeded\n{}", m.logs.join("\n")),
        Err(f) => println!("{what}: refused with {:?}", f.err),
    }
    assert_eq!(env.snapshot(watch), before, "{what}: a failed tx changed balances");
}

#[test]
fn r2_p1_sweep_to_attacker_recipient_is_refused() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let trader = env.funded(20);
    let evs = env.buy_v3(&trader, &l.mint, 3 * LAMPORTS_PER_SOL);
    let bucket = env.curve(&l.mint).creator_fee_bucket;
    assert!(bucket > 0 && bucket == evs[0].creator_fee);
    let attacker = env.funded(5);
    let watch = [l.curve, l.vault, creator_vault(&l.vault), creator_vault(&attacker.pubkey())];
    // (a) the attacker's own wallet as recipient
    must_fail(&mut env, &[cu_limit(200_000), sweep_to(attacker.pubkey(), l.mint, attacker.pubkey())], &attacker, &watch, "sweep → attacker wallet");
    // (b) the attacker's pump creator vault (then collect_creator_fee(attacker) would pay the attacker)
    must_fail(
        &mut env,
        &[cu_limit(200_000), sweep_to(attacker.pubkey(), l.mint, creator_vault(&attacker.pubkey()))],
        &attacker,
        &watch,
        "sweep → creator_vault(attacker)",
    );
    // (c) our vault itself (not its pump creator vault)
    must_fail(&mut env, &[cu_limit(200_000), sweep_to(attacker.pubkey(), l.mint, l.vault)], &attacker, &watch, "sweep → vault directly");
    assert_eq!(env.curve(&l.mint).creator_fee_bucket, bucket);
    // The canonical sweep still pays the shop exactly the bucket.
    let v0 = env.lamports(&l.vault);
    env.sweep_and_collect(&l.mint, &l.vault);
    assert_eq!(env.lamports(&l.vault) - v0, bucket);
}

#[test]
fn r2_p2_collect_with_mismatched_creator_is_refused() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let trader = env.funded(20);
    let evs = env.buy_v2(&trader, &l.mint, &l.vault, 10_000_000_000_000, 5 * LAMPORTS_PER_SOL);
    let fee = evs[0].creator_fee;
    let cv = creator_vault(&l.vault);
    assert_eq!(env.lamports(&cv), fee + env.rent(0));
    let attacker = env.funded(5);
    let ix = Instruction {
        program_id: PUMP,
        accounts: vec![w(attacker.pubkey()), w(cv), ro(SYSTEM), ro(EVENT_AUTHORITY), ro(PUMP)],
        data: vec![0x14, 0x16, 0x56, 0x7b, 0xc6, 0x1c, 0xdb, 0x84],
    };
    must_fail(&mut env, &[ix], &attacker, &[cv, l.vault], "collect(creator = attacker, creator_vault = ours)");
}

#[test]
fn r2_p3_legacy_v1_trades_pay_the_vault() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let trader = env.funded(50);
    let v0 = env.lamports(&l.vault);
    let mut fees = 0u64;
    let m = ok(env.send(
        &[
            cu_limit(400_000),
            create_ata_idempotent(trader.pubkey(), trader.pubkey(), l.mint, TOKEN_2022),
            buy_v1(trader.pubkey(), l.mint, l.vault, 5_000_000_000_000, 2 * LAMPORTS_PER_SOL),
        ],
        &trader,
        &[],
    ));
    let evs = trade_events(&m);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].creator, l.vault);
    fees += evs[0].creator_fee;
    let m = ok(env.send(&[cu_limit(400_000), buy_exact_sol_in_v1(trader.pubkey(), l.mint, l.vault, LAMPORTS_PER_SOL)], &trader, &[]));
    fees += trade_events(&m)[0].creator_fee;
    let bal = env.token_balance(&trader.pubkey(), &l.mint);
    let m = ok(env.send(&[cu_limit(400_000), sell_v1(trader.pubkey(), l.mint, l.vault, bal / 3, &[])], &trader, &[]));
    fees += trade_events(&m)[0].creator_fee;
    assert!(fees > 0);
    assert_eq!(env.curve(&l.mint).creator_fee_bucket, 0, "v1 trades pay the creator vault directly");
    let cranker = env.cranker.insecure_clone();
    ok(env.send(&[collect_creator_fee(l.vault)], &cranker, &[]));
    assert_eq!(env.lamports(&l.vault) - v0, fees, "every v1 creator fee reaches the shop vault");
    println!("R2-P3: v1 buy + buy_exact_sol_in + sell creator fees = {fees} lamports, all collected into the vault");
}

#[test]
fn r2_p4_cashback_remaining_accounts_cannot_redirect_creator_fee() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let trader = env.funded(50);
    env.buy_v3(&trader, &l.mint, 2 * LAMPORTS_PER_SOL); // creates the trader's user_volume_accumulator
    let uva = user_volume_accumulator(&trader.pubkey());
    let cv = creator_vault(&l.vault);
    // creator_vault rent floor must exist first (v1 sell pays into it).
    env.fund(&cv, env.rent(0));
    let cv0 = env.lamports(&cv);
    let uva0 = env.lamports(&uva);
    let bal = env.token_balance(&trader.pubkey(), &l.mint);
    let r = env.send(
        &[cu_limit(400_000), sell_v1(trader.pubkey(), l.mint, l.vault, bal / 2, &[w(uva)])],
        &trader,
        &[],
    );
    match r {
        Err(f) => println!("R2-P4: v1 sell with cashback remaining accounts refused: {:?}", f.err),
        Ok(m) => {
            let evs = trade_events(&m);
            let cb = trade_cashback(&m);
            println!("R2-P4: v1 sell with cashback accounts ok; creator_fee {} cashback {:?}", evs[0].creator_fee, cb);
            assert_eq!(cb, vec![0], "EXPLOIT: a non-cashback coin paid cashback");
            assert_eq!(env.lamports(&cv) - cv0, evs[0].creator_fee, "EXPLOIT: creator fee did not reach creator_vault(vault)");
            assert!(env.lamports(&uva) <= uva0, "EXPLOIT: creator fee diverted to the seller's volume accumulator");
        }
    }
}

#[test]
fn r2_p5_configurable_creator_fee_bps_is_ignored_for_sol_coins() {
    for bps in [1u64, 300] {
        let mut env = Env::initialized();
        let ph = place_hash(PLACE);
        let launcher = env.funded(10);
        let mint = Keypair::new();
        let create = CreateArgs::sol(sv::vault_pda(&ph).0);
        let mut ixs = env.launch_ixs(&launcher.pubkey(), &mint.pubkey(), &ph, &create, 0);
        // create_v2 data ends with: creator_fee_bps u64 ‖ is_holder_reward u8.
        let d = &mut ixs[1].data;
        let n = d.len();
        d[n - 9..n - 1].copy_from_slice(&bps.to_le_bytes());
        let attestor = env.attestor.insecure_clone();
        let r = env.send(&ixs, &launcher, &[&mint, &attestor]);
        let Ok(_) = r else {
            println!("R2-P5: create_v2(creator_fee_bps = {bps}) refused: {:?}", r.unwrap_err().err);
            continue;
        };
        let raw = env.account(&bonding_curve(&mint.pubkey())).unwrap().data;
        let stored = u64::from_le_bytes(raw[115..123].try_into().unwrap());
        let trader = env.funded(10);
        let m = ok(env.send(
            &[
                cu_limit(400_000),
                create_ata_idempotent(trader.pubkey(), trader.pubkey(), mint.pubkey(), TOKEN_2022),
                buy_exact_quote_in_v3(trader.pubkey(), mint.pubkey(), LAMPORTS_PER_SOL, 1),
            ],
            &trader,
            &[],
        ));
        let rate = trade_creator_fee_bps(&m);
        println!("R2-P5: create_v2(creator_fee_bps = {bps}) registered; curve.creator_fee_bps = {stored}; trade creator rate = {rate:?} bps");
        assert_eq!(stored, 0, "SOL coin stored a custom creator_fee_bps");
        assert_eq!(rate, vec![30], "creator rate differs from the 0.30% schedule");
    }
}

#[test]
fn r2_p6_bucket_on_a_completed_curve_is_still_collectable() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let whale = env.funded(500);
    let mut fees: u64 = env.buy_v3(&whale, &l.mint, 20 * LAMPORTS_PER_SOL).iter().map(|e| e.creator_fee).sum();
    let bucket = env.curve(&l.mint).creator_fee_bucket;
    assert_eq!(bucket, fees);
    // Complete the curve: buy exactly the remaining real tokens with buy_v2.
    let remaining = env.curve(&l.mint).real_token_reserves;
    fees += env.buy_v2(&whale, &l.mint, &l.vault, remaining, 400 * LAMPORTS_PER_SOL).iter().map(|e| e.creator_fee).sum::<u64>();
    let c = env.curve(&l.mint);
    println!("R2-P6: complete = {}, bucket = {}, Σ creator_fee = {fees}", c.complete, c.creator_fee_bucket);
    assert!(c.complete, "curve should be complete");
    // Later trades are refused until migration, but sweep + collect still pay everything to the vault.
    let v0 = env.lamports(&l.vault);
    env.sweep_and_collect(&l.mint, &l.vault);
    assert_eq!(env.lamports(&l.vault) - v0, fees, "all fees of a completed curve reach the vault");
    assert_eq!(env.curve(&l.mint).creator_fee_bucket, 0);
}

#[test]
fn r2_p7_amm_collect_coin_creator_fee_cannot_pay_an_attacker() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let auth = amm_creator_vault_authority(&l.vault);
    let amm_ata = wsol_ata(&auth);
    // Fabricate graduated creator fees: anyone can create the AMM creator-vault WSOL ATA and wrap SOL into it.
    let funder = env.funded(10);
    ok(env.send(
        &[
            create_ata_idempotent(funder.pubkey(), auth, NATIVE_MINT, SPL_TOKEN),
            system_transfer(funder.pubkey(), amm_ata, LAMPORTS_PER_SOL),
            sync_native(amm_ata),
        ],
        &funder,
        &[],
    ));
    let attacker = env.funded(5);
    let attacker_wsol = wsol_ata(&attacker.pubkey());
    ok(env.send(&[create_ata_idempotent(attacker.pubkey(), attacker.pubkey(), NATIVE_MINT, SPL_TOKEN)], &attacker, &[]));
    must_fail(
        &mut env,
        &[amm_collect_coin_creator_fee(l.vault, attacker_wsol)],
        &attacker,
        &[amm_ata, attacker_wsol, l.vault],
        "pump_amm collect_coin_creator_fee → attacker WSOL account",
    );
    // Into the vault's own WSOL ATA it is permissionless, and unwrap_wsol lands it in the vault.
    let vault_wsol = wsol_ata(&l.vault);
    ok(env.send(&[create_ata_idempotent(attacker.pubkey(), l.vault, NATIVE_MINT, SPL_TOKEN)], &attacker, &[]));
    let r = env.send(&[amm_collect_coin_creator_fee(l.vault, vault_wsol)], &attacker, &[]);
    match r {
        Ok(_) => {
            let v0 = env.lamports(&l.vault);
            let wsol = env.lamports(&vault_wsol);
            ok(env.send(&[sv::unwrap_wsol(&l.ph, vault_wsol)], &attacker, &[]));
            assert_eq!(env.lamports(&l.vault) - v0, wsol);
            println!("R2-P7: collect_coin_creator_fee → vault WSOL ATA ok; unwrap moved {wsol} lamports into the vault");
        }
        Err(f) => println!("R2-P7: collect_coin_creator_fee → vault WSOL ATA refused too: {:?}\n{}", f.err, f.meta.logs.join("\n")),
    }
}
