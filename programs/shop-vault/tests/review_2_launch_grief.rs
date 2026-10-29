//! REVIEW-2 (adversarial): can a launch be squatted, front-run or permanently bricked by someone WITHOUT the attestor
//! key? Everything an outsider can do is (a) send lamports to any address, (b) create ATAs / pump PDAs owned by
//! anyone, (c) create unregistered pump coins with `creator = vault(place)`. Each test asserts the SAFE outcome:
//! the place is never bricked (a retry with a fresh server mint registers it) and outsiders never capture fees.
#![allow(clippy::result_large_err, deprecated)]
mod common;

use common::*;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

const PLACE: &str = "ChIJN1t_tDeuEmsRUsoyG83frY4";

fn donate(env: &mut Env, to: &Address, lamports: u64) {
    let d = env.funded(lamports / LAMPORTS_PER_SOL + 1);
    ok(env.send(&[system_transfer(d.pubkey(), *to, lamports)], &d, &[]));
}

/// R2-L1: a front-runner who saw the reserved mint pre-funds every address `create_v2` will create for it.
/// Outcome recorded; the place itself must stay launchable with a fresh mint.
#[test]
fn r2_l1_prefunding_the_reserved_mints_pump_accounts_never_bricks_the_place() {
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let mint = Keypair::new();
    let m = mint.pubkey();
    let curve = bonding_curve(&m);
    let targets = [
        ("mint", m),
        ("bonding_curve", curve),
        ("associated_bonding_curve", ata(&curve, &m, &TOKEN_2022)),
        ("mayhem_state", mayhem_state(&m)),
        ("sol_vault mint ATA", ata(&SOL_VAULT, &m, &TOKEN_2022)),
    ];
    for (name, addr) in targets {
        let mut e2 = Env::initialized();
        let r = {
            let r0 = e2.rent(0);
            e2.fund(&addr, r0);
            let launcher = e2.funded(10);
            e2.try_launch(PLACE, &launcher, &mint, 10_000_000)
        };
        println!("R2-L1 pre-funded {name}: launch {}", match &r { Ok(_) => "OK".into(), Err(f) => format!("FAILED {:?}", f.err) });
        if r.is_err() {
            // The whole tx reverted: no VaultState, and the place is still free for a fresh mint.
            assert!(e2.account(&sv::state_pda(&ph).0).is_none());
            let launcher = e2.funded(10);
            ok(e2.try_launch(PLACE, &launcher, &Keypair::new(), 10_000_000));
        }
    }
    // Same thing on our own accounts: vault, vault_state, the vault's pump creator vault, its WSOL ATA and its
    // Token-2022 ATA of the reserved mint are all pre-created / pre-funded by a griefer.
    let griefer = env.funded(10);
    donate(&mut env, &sv::vault_pda(&ph).0, 7_777_777);
    donate(&mut env, &sv::state_pda(&ph).0, 3_333_333);
    let r0 = env.rent(0);
    donate(&mut env, &creator_vault(&sv::vault_pda(&ph).0), r0);
    ok(env.send(
        &[
            create_ata_idempotent(griefer.pubkey(), sv::vault_pda(&ph).0, NATIVE_MINT, SPL_TOKEN),
        ],
        &griefer,
        &[],
    ));
    let launcher = env.funded(10);
    let l = ok(env.try_launch(PLACE, &launcher, &mint, 10_000_000));
    assert_eq!(env.state(&ph).mint, m);
    assert_eq!(env.lamports(&sv::vault_pda(&ph).0), 7_777_777, "pre-funded vault adopted, top-up skipped");
    println!("R2-L1 own accounts pre-funded/pre-created: launch OK (CU {})", l.compute_units_consumed);
}

/// R2-L2: an outsider front-runs the official launch with their own pump coin whose creator is the place's vault
/// (and an offensive name). It must not block the official launch, cannot be registered without the attestor, and
/// every creator fee it earns still lands in the shop vault (the outsider captures nothing).
#[test]
fn r2_l2_unregistered_squat_coin_cannot_block_or_capture() {
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let vault = sv::vault_pda(&ph).0;
    let squatter = env.funded(20);
    let squat_mint = Keypair::new();
    let mut args = CreateArgs::sol(vault);
    args.name = "Not Affiliated Rug".into();
    ok(env.send(&[cu_limit(400_000), create_v2(squat_mint.pubkey(), squatter.pubkey(), &args)], &squatter, &[&squat_mint]));
    // Without the attestor, register_launch for the squat coin is refused.
    let r = env.send(&[sv::register_launch(squatter.pubkey(), squatter.pubkey(), &ph, squat_mint.pubkey())], &squatter, &[]);
    expect_custom(&r, e::ATTESTOR_MISMATCH);
    // Trading the squat coin pays the shop vault (collectable once the place is registered).
    let trader = env.funded(20);
    let evs = env.buy_v3(&trader, &squat_mint.pubkey(), 2 * LAMPORTS_PER_SOL);
    assert_eq!(evs[0].creator, vault);
    // Official launch with the server's mint still works.
    let l = env.launch(PLACE, 0);
    assert_eq!(env.state(&ph).mint, l.mint);
    let v0 = env.lamports(&vault);
    env.sweep_and_collect(&squat_mint.pubkey(), &vault);
    assert_eq!(env.lamports(&vault) - v0, evs[0].creator_fee, "squat coin's fees accrue to the shop");
    println!("R2-L2: squat coin pre-launch did not block; its {} lamports of creator fees went to the shop vault", evs[0].creator_fee);
}
