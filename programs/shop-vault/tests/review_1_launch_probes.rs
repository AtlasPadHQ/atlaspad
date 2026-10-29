//! Review 1 (adversarial): probes of the launch path that the existing LCH-* tests do not cover.
//!
//! - `creator_fee_bps` in `create_v2` is not checked by `register_launch` nor by `checkLaunchMessage`
//!   (client/src/attestation.ts decodes it but never compares it). Does pump honour it for a SOL coin?
//! - "Pre-traded curve": is `real_quote_reserves == 0` really proof that nobody traded the curve?
//! - The attestor co-signature is not bound to one instruction on-chain: what does an appended
//!   attestor-gated instruction do inside a co-signed launch tx?
#![allow(clippy::result_large_err, deprecated)]
mod common;

use common::*;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;

const DEV_BUY: u64 = 10_000_000;

fn raw_trade_creator_fee_bps(m: &litesvm::types::TransactionMetadata) -> Vec<(u64, u64)> {
    // (creator_fee_bps @201, creator_fee @209) of every TradeEvent in the tx.
    m.inner_instructions
        .iter()
        .flatten()
        .filter_map(|ix| {
            let d = &ix.instruction.data;
            if d.len() < 16 + 217 || d[..8] != EVENT_IX_TAG || d[8..16] != TRADE_EVENT_DISC {
                return None;
            }
            let e = &d[16..];
            Some((u64::from_le_bytes(e[201..209].try_into().unwrap()), u64::from_le_bytes(e[209..217].try_into().unwrap())))
        })
        .collect()
}

/// Launch `place` with create_v2's `creator_fee_bps` patched to `bps` (everything else as the Worker policy allows).
fn launch_with_fee_bps(env: &mut Env, place: &str, bps: u64) -> (TxResult, Address, [u8; 32]) {
    let ph = place_hash(place);
    let launcher = env.funded(10);
    let mint = Keypair::new();
    let mut ixs = env.launch_ixs(&launcher.pubkey(), &mint.pubkey(), &ph, &CreateArgs::sol(sv::vault_pda(&ph).0), DEV_BUY);
    // ixs[1] is create_v2: [.. creator:32 mayhem:1 cashback:1 creator_fee_bps:8 holder_reward:1]
    let d = &mut ixs[1].data;
    let n = d.len();
    d[n - 9..n - 1].copy_from_slice(&bps.to_le_bytes());
    let attestor = env.attestor.insecure_clone();
    let r = env.send(&ixs, &launcher, &[&mint, &attestor]);
    (r, mint.pubkey(), ph)
}

/// `creator_fee_bps` on a SOL create_v2: record whether pump accepts/stores/honours it.
#[test]
fn r1_creator_fee_bps_on_sol_create_v2_is_ignored_by_pump() {
    let mut env = Env::initialized();
    let trader = env.funded(50);

    let (r0, mint0, _) = launch_with_fee_bps(&mut env, "r1:fee-default", 0);
    ok(r0);
    let base = {
        let ixs = vec![
            cu_limit(400_000),
            create_ata_idempotent(trader.pubkey(), trader.pubkey(), mint0, TOKEN_2022),
            buy_exact_quote_in_v3(trader.pubkey(), mint0, LAMPORTS_PER_SOL / 10, 1),
        ];
        let m = ok(env.send(&ixs, &trader, &[]));
        raw_trade_creator_fee_bps(&m)
    };
    println!("default coin: (creator_fee_bps, creator_fee) = {base:?}");
    let curve0 = env.account(&bonding_curve(&mint0)).unwrap().data;
    println!("default curve @115 creator_fee_bps={} @123 can_edit={}", u64::from_le_bytes(curve0[115..123].try_into().unwrap()), curve0[123]);

    for bps in [1u64, 25, 100, 10_000] {
        let (r, mint, _) = launch_with_fee_bps(&mut env, &format!("r1:fee-{bps}"), bps);
        match &r {
            Err(f) => println!("creator_fee_bps={bps}: launch FAILED {:?}", f.err),
            Ok(_) => {
                let c = env.account(&bonding_curve(&mint)).unwrap().data;
                let stored = u64::from_le_bytes(c[115..123].try_into().unwrap());
                let ixs = vec![
                    cu_limit(400_000),
                    create_ata_idempotent(trader.pubkey(), trader.pubkey(), mint, TOKEN_2022),
                    buy_exact_quote_in_v3(trader.pubkey(), mint, LAMPORTS_PER_SOL / 10, 1),
                ];
                let m = ok(env.send(&ixs, &trader, &[]));
                let ev = raw_trade_creator_fee_bps(&m);
                println!("creator_fee_bps={bps}: launch ok, stored @115={stored} can_edit@123={} trade={ev:?}", c[123]);
                // The shop's rate must not be launcher-controllable.
                assert_eq!(stored, 0, "pump stored a launcher-chosen creator_fee_bps on a SOL coin");
                assert_eq!(ev[0].0, base[0].0, "creator fee rate changed by the launcher-chosen creator_fee_bps");
            }
        }
    }
}

/// Is `real_quote_reserves == 0` (register check 8) proof of "never traded"? Buy then sell everything back.
#[test]
fn r1_round_trip_trade_and_real_quote_reserves() {
    let mut env = Env::initialized();
    let ph = place_hash("r1:roundtrip");
    let vault = sv::vault_pda(&ph).0;
    // A coin created OUTSIDE our UI (no register) with creator = the place vault.
    let outsider = env.funded(10);
    let mint = Keypair::new();
    ok(env.send(&[cu_limit(400_000), create_v2(mint.pubkey(), outsider.pubkey(), &CreateArgs::sol(vault))], &outsider, &[&mint]));
    let trader = env.funded(10);
    for spend in [1_000_000u64, 10_000_000, 123_456_789] {
        env.buy_v3(&trader, &mint.pubkey(), spend);
        let bal = env.token_balance(&trader.pubkey(), &mint.pubkey());
        env.sell_v3(&trader, &mint.pubkey(), bal);
        let c = env.curve(&mint.pubkey());
        println!(
            "after buy {spend} + sell-all: real_quote_reserves={} real_token_reserves={} creator_fee_bucket={}",
            c.real_quote_reserves, c.real_token_reserves, c.creator_fee_bucket
        );
    }
}

/// FIXED. Exploit: a co-signed launch tx for X also carried cancel_claim(attestor, Y) and set_paused(attestor, 1), and
/// both ran on the attestor's signature. Now (a) the attestor has no admin power, so those instructions fail on their
/// own, and (b) register_launch refuses any tx with another top-level shop-vault instruction, so even a smuggled
/// attestor-gated request_claim (the attestor's remaining power) cannot ride along. The whole tx reverts.
#[test]
fn r1_cosigned_launch_can_carry_other_attestor_powers_on_chain() {
    let mut env = Env::initialized();
    // Place Y has a pending claim by a legitimate owner.
    let y = env.launch("r1:place-y", 0);
    let legit = env.funded(1);
    ok(env.request_claim(&y.ph, &legit, 1));
    assert!(env.state(&y.ph).has_pending);
    let z = env.launch("r1:place-z", 0);

    let ph = place_hash("r1:place-x");
    let launcher = env.funded(10);
    let attestor = env.attestor.insecure_clone();
    let thief = env.funded(1);
    let extras: Vec<(Instruction, Vec<&Keypair>)> = vec![
        (sv::cancel_claim(attestor.pubkey(), &y.ph), vec![]),
        (sv::set_paused(attestor.pubkey(), 1), vec![]),
        (sv::request_claim(attestor.pubkey(), thief.pubkey(), &z.ph, 1), vec![&thief]),
    ];
    for (extra, more) in extras {
        for before in [false, true] {
            let mint = Keypair::new();
            let mut ixs: Vec<Instruction> =
                env.launch_ixs(&launcher.pubkey(), &mint.pubkey(), &ph, &CreateArgs::sol(sv::vault_pda(&ph).0), 0);
            if before {
                ixs.insert(0, extra.clone());
            } else {
                ixs.push(extra.clone());
            }
            let mut signers = vec![&mint, &attestor];
            signers.extend(more.iter().copied());
            let r = env.send(&ixs, &launcher, &signers);
            assert!(r.is_err(), "co-signed launch with an extra shop-vault instruction must fail");
            assert!(env.account(&mint.pubkey()).is_none(), "whole launch reverted");
        }
    }
    // The extra instructions also fail on their own: the attestor has no admin power.
    expect_custom(&env.send(&[sv::cancel_claim(attestor.pubkey(), &y.ph)], &launcher, &[&attestor]), e::UNAUTHORIZED);
    expect_custom(&env.send(&[sv::set_paused(attestor.pubkey(), 1)], &launcher, &[&attestor]), e::UNAUTHORIZED);
    assert!(env.state(&y.ph).has_pending, "Y's claim untouched");
    assert!(!env.state(&z.ph).has_pending, "no smuggled claim on Z");
    assert_eq!(env.config().paused, 0);
    assert!(env.account(&sv::state_pda(&ph).0).is_none(), "X not registered");
}
