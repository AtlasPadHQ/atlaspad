//! LCH-*: `register_launch` in the same tx as the real pump `create_v2` (SPEC §5.2, §8.1, §13.3).
#![allow(clippy::result_large_err, deprecated)]
mod common;

use common::*;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;

const PLACE: &str = "ChIJN1t_tDeuEmsRUsoyG83frY4";
const DEV_BUY: u64 = 10_000_000; // 0.01 SOL

/// Keys whose state must be untouched by a failing launch.
fn watch(ph: &[u8; 32], mint: &Address) -> Vec<Address> {
    vec![sv::config_pda().0, sv::state_pda(ph).0, sv::vault_pda(ph).0, *mint, bonding_curve(mint)]
}

/// Sends `ixs`, expects a failure, and asserts that nothing in `watch` changed and no mint exists.
#[track_caller]
fn fails_atomically(env: &mut Env, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair], ph: &[u8; 32], mint: &Address) -> TxResult {
    let keys = watch(ph, mint);
    let before = env.snapshot(&keys);
    let r = env.send(ixs, payer, extra);
    assert!(r.is_err(), "expected failure");
    assert_eq!(env.snapshot(&keys), before, "a failed launch changed state");
    assert!(env.account(mint).is_none(), "no orphan mint after a reverted launch");
    r
}

/// [cu, create_v2(creator = vault(ph)), <reg>, ATA, dev buy].
fn launch_with(launcher: &Address, mint: &Address, ph: &[u8; 32], reg: Instruction) -> Vec<Instruction> {
    let create = CreateArgs::sol(sv::vault_pda(ph).0);
    vec![
        cu_limit(600_000),
        create_v2(*mint, *launcher, &create),
        reg,
        create_ata_idempotent(*launcher, *launcher, *mint, TOKEN_2022),
        buy_exact_quote_in_v3(*launcher, *mint, DEV_BUY, 1),
    ]
}

fn set_meta(ix: &mut Instruction, idx: usize, pubkey: Address, signer: bool, writable: bool) {
    ix.accounts[idx] = AccountMeta { pubkey, is_signer: signer, is_writable: writable };
}

// ---------------------------------------------------------------------------------------------- LCH-01

/// LCH-01: the atomic launch tx through a lookup table: state, creator, vault rent, size ≤ 1,232 B, CU.
#[test]
fn lch01_happy_atomic_launch_through_alt() {
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let (vault, vault_bump) = sv::vault_pda(&ph);
    let (state, state_bump) = sv::state_pda(&ph);

    // One CORNERSHOP ALT holding only keys that are identical across launches (SPEC §8.1).
    let alt_key = Address::new_unique();
    let alt = env.put_alt(
        alt_key,
        &[
            GLOBAL,
            MINT_AUTHORITY,
            EVENT_AUTHORITY,
            GLOBAL_PARAMS,
            SOL_VAULT,
            FEE_CONFIG,
            TOKEN_2022,
            SPL_TOKEN,
            ATA_PROGRAM,
            NATIVE_MINT,
            BUYBACK_RECIPIENT,
            sv::SYSTEM,
            sv::config_pda().0,
            PUMP,
            MAYHEM,
            sv::INSTRUCTIONS_SYSVAR,
        ],
    );

    let mut sizes = vec![];
    for (i, (name, symbol, uri_len)) in [("Corner Cafe Ltd", "CAFE", 80usize), ("N".repeat(32).leak() as &str, "ABCDEFGHIJ", 100)].iter().enumerate() {
        let launcher = env.funded(5);
        let mint = Keypair::new();
        let attestor = env.attestor.insecure_clone();
        let place = format!("{PLACE}-{i}");
        let ph = place_hash(&place);
        let mut create = CreateArgs::sol(sv::vault_pda(&ph).0);
        create.name = name.to_string();
        create.symbol = symbol.to_string();
        create.uri = format!("https://cornershop.tiejiucai.workers.dev/m/{}", "x".repeat(uri_len - 43));
        assert_eq!(create.uri.len(), *uri_len);
        let ixs = vec![
            cu_limit(400_000),
            cu_price(100_000),
            create_v2(mint.pubkey(), launcher.pubkey(), &create),
            sv::register_launch(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey()),
            create_ata_idempotent(launcher.pubkey(), launcher.pubkey(), mint.pubkey(), TOKEN_2022),
            buy_exact_quote_in_v3(launcher.pubkey(), mint.pubkey(), DEV_BUY, 1),
        ];
        let tx = env.v0_tx(&ixs, &launcher, &[&mint, &attestor], std::slice::from_ref(&alt));
        assert_eq!(tx.signatures.len(), 3, "launcher, mint, attestor");
        let size = tx_size(&tx);
        sizes.push(size);
        assert!(size <= 1232, "launch tx is {size} B > 1232 B");
        let m = ok(env.svm.send_transaction(tx));
        env.svm.expire_blockhash();
        let cu = shop_vault_cu(&m);
        println!("LCH-01 variant {i}: tx {size} B, total CU {}, register_launch CU {:?}", m.compute_units_consumed, cu);
        assert!(cu[0] <= 25_000, "register_launch CU {} > 25k", cu[0]);
        assert_eq!(env.curve(&mint.pubkey()).creator, sv::vault_pda(&ph).0);
    }
    println!("LCH-01 sizes (typical, max metadata): {sizes:?}");

    // The plain helper launch: check every field.
    let l = env.launch(PLACE, DEV_BUY);
    let st = env.state(&ph);
    assert_eq!((st.tag, st.version, st.state_bump, st.vault_bump), (2, 1, state_bump, vault_bump));
    assert_eq!(st.place_hash, ph);
    assert_eq!(st.mint, l.mint);
    assert_eq!(st.launcher, l.launcher.pubkey());
    assert!(!st.has_owner && !st.has_pending);
    assert_eq!((st.owner, st.pending_owner), (Address::default(), Address::default()));
    assert_eq!((st.unlock_ts, st.claim_nonce, st.total_withdrawn, st.owner_since), (0, 0, 0, 0));
    assert_eq!(st.created_at, env.now());
    let c = env.curve(&l.mint);
    assert_eq!(c.creator, vault);
    assert!(c.real_quote_reserves > 0, "dev buy ran after register");
    let va = env.account(&vault).unwrap();
    assert_eq!(va.owner, sv::SYSTEM);
    assert!(va.data.is_empty());
    assert_eq!(va.lamports, env.rent(0), "vault topped up to exactly rent_min(0)");
    let sa = env.account(&state).unwrap();
    assert_eq!((sa.owner, sa.data.len(), sa.lamports), (PROGRAM_ID, 208, env.rent(208)));
    // Registered event: place_hash, mint, launcher, vault, vault_state.
    let ev = program_events(&l.meta, "Registered");
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0][1], ph.to_vec());
    assert_eq!(ev[0][2], l.mint.as_ref().to_vec());
    assert_eq!(ev[0][3], l.launcher.pubkey().as_ref().to_vec());
    assert_eq!(ev[0][4], vault.as_ref().to_vec());
    assert_eq!(ev[0][5], state.as_ref().to_vec());
    // Our rent per launch = (128 + 0) + (128 + 208) bytes × lamports/byte (mainnet 5,080/B → 2,357,120 lamports).
    let lpb = env.rent(0) / 128;
    assert_eq!(env.rent(0) + env.rent(208), 464 * lpb);
    assert_eq!(464 * 5_080, 2_357_120);
}

// ---------------------------------------------------------------------------------------------- LCH-02

#[test]
fn lch02_second_launch_same_place_reverts_whole_tx() {
    let mut env = Env::initialized();
    let first = env.launch(PLACE, DEV_BUY);
    let ph = first.ph;
    let launcher = env.funded(5);
    let mint2 = Keypair::new();
    let attestor = env.attestor.insecure_clone();
    let ixs = env.launch_ixs(&launcher.pubkey(), &mint2.pubkey(), &ph, &CreateArgs::sol(first.vault), DEV_BUY);
    let state_before = env.state(&ph);
    let r = env.send(&ixs, &launcher, &[&mint2, &attestor]);
    expect_custom_at(&r, 2, e::ALREADY_REGISTERED);
    assert!(env.account(&mint2.pubkey()).is_none(), "second mint must not exist");
    assert!(env.account(&bonding_curve(&mint2.pubkey())).is_none());
    assert_eq!(env.state(&ph), state_before);
    assert_eq!(env.state(&ph).mint, first.mint);
}

// ---------------------------------------------------------------------------------------------- LCH-03

#[test]
fn lch03_attestor_missing_wrong_expired_or_replayed() {
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let launcher = env.funded(5);

    // Attestor listed but not signing.
    let mint = Keypair::new();
    let mut reg = sv::register_launch(launcher.pubkey(), env.attestor.pubkey(), &ph, mint.pubkey());
    set_meta(&mut reg, 1, env.attestor.pubkey(), false, false);
    let ixs = launch_with(&launcher.pubkey(), &mint.pubkey(), &ph, reg);
    let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint], &ph, &mint.pubkey());
    expect_ix(&r, InstructionError::MissingRequiredSignature);

    // A random key co-signs in the attestor slot.
    let fake = Keypair::new();
    let reg = sv::register_launch(launcher.pubkey(), fake.pubkey(), &ph, mint.pubkey());
    let ixs = launch_with(&launcher.pubkey(), &mint.pubkey(), &ph, reg);
    let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &fake], &ph, &mint.pubkey());
    expect_custom_at(&r, 2, e::ATTESTOR_MISMATCH);

    // The launcher signs as "attestor" itself.
    let reg = sv::register_launch(launcher.pubkey(), launcher.pubkey(), &ph, mint.pubkey());
    let ixs = launch_with(&launcher.pubkey(), &mint.pubkey(), &ph, reg);
    let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint], &ph, &mint.pubkey());
    expect_custom_at(&r, 2, e::ATTESTOR_MISMATCH);

    // Expired attestation: the co-signed tx's blockhash is no longer valid.
    let attestor = env.attestor.insecure_clone();
    let ixs = env.launch_ixs(&launcher.pubkey(), &mint.pubkey(), &ph, &CreateArgs::sol(sv::vault_pda(&ph).0), DEV_BUY);
    let tx = env.tx(&ixs, &launcher, &[&mint, &attestor]);
    env.svm.expire_blockhash();
    let r = env.svm.send_transaction(tx);
    expect_tx_err(&r, TransactionError::BlockhashNotFound);
    assert!(env.account(&mint.pubkey()).is_none());

    // Replay: the identical signed tx is processed once only.
    let tx = env.tx(&ixs, &launcher, &[&mint, &attestor]);
    ok(env.svm.send_transaction(tx.clone()));
    let r = env.svm.send_transaction(tx);
    expect_tx_err(&r, TransactionError::AlreadyProcessed);
    env.svm.expire_blockhash();
    // And a fresh copy for the same place (new mint) is AlreadyRegistered.
    let mint2 = Keypair::new();
    let ixs = env.launch_ixs(&launcher.pubkey(), &mint2.pubkey(), &ph, &CreateArgs::sol(sv::vault_pda(&ph).0), DEV_BUY);
    let r = env.send(&ixs, &launcher, &[&mint2, &attestor]);
    expect_custom_at(&r, 2, e::ALREADY_REGISTERED);
}

// ---------------------------------------------------------------------------------------------- LCH-04

#[test]
fn lch04_paused_blocks_launches_only_until_unpaused() {
    let mut env = Env::initialized();
    let gov = env.governance.insecure_clone();
    let payer = gov_payer(&mut env, &gov);
    ok(env.send(&[sv::set_paused(gov.pubkey(), 1)], &payer, &[&gov]));
    assert_eq!(env.config().paused, 1);
    let ph = place_hash(PLACE);
    let launcher = env.funded(5);
    let mint = Keypair::new();
    let attestor = env.attestor.insecure_clone();
    let ixs = env.launch_ixs(&launcher.pubkey(), &mint.pubkey(), &ph, &CreateArgs::sol(sv::vault_pda(&ph).0), DEV_BUY);
    let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
    expect_custom_at(&r, 2, e::LAUNCHES_PAUSED);
    // The attestor (online key) cannot unpause: it has no admin power (review finding R1).
    expect_custom(&env.send(&[sv::set_paused(attestor.pubkey(), 0)], &launcher, &[&attestor]), e::UNAUTHORIZED);
    let grd = env.guardian.insecure_clone();
    ok(env.send(&[sv::set_paused(grd.pubkey(), 0)], &launcher, &[&grd]));
    ok(env.send(&ixs, &launcher, &[&mint, &attestor]));
    assert_eq!(env.state(&ph).mint, mint.pubkey());
}

fn gov_payer(env: &mut Env, gov: &Keypair) -> Keypair {
    env.fund(&gov.pubkey(), LAMPORTS_PER_SOL);
    gov.insecure_clone()
}

// ---------------------------------------------------------------------------------------------- LCH-05

#[test]
fn lch05_creator_is_launcher_or_another_places_vault() {
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let launcher = env.funded(5);
    let mint = Keypair::new();
    let attestor = env.attestor.insecure_clone();
    for creator in [launcher.pubkey(), sv::vault_pda(&place_hash("some-other-place")).0, Address::new_unique()] {
        let mut ixs = env.launch_ixs(&launcher.pubkey(), &mint.pubkey(), &ph, &CreateArgs::sol(creator), DEV_BUY);
        ixs[1] = create_v2(mint.pubkey(), launcher.pubkey(), &CreateArgs::sol(creator));
        let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
        expect_custom_at(&r, 2, e::CREATOR_MISMATCH);
    }
}

// ---------------------------------------------------------------------------------------------- LCH-06/07

#[test]
fn lch06_register_before_create_fails() {
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let launcher = env.funded(5);
    let mint = Keypair::new();
    let attestor = env.attestor.insecure_clone();
    let mut ixs = env.launch_ixs(&launcher.pubkey(), &mint.pubkey(), &ph, &CreateArgs::sol(sv::vault_pda(&ph).0), DEV_BUY);
    ixs.swap(1, 2); // register, then create
    let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
    expect_custom_at(&r, 1, e::INVALID_BONDING_CURVE);
}

#[test]
fn lch07_dev_buy_before_register_is_not_fresh() {
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let launcher = env.funded(5);
    let mint = Keypair::new();
    let attestor = env.attestor.insecure_clone();
    let ixs0 = env.launch_ixs(&launcher.pubkey(), &mint.pubkey(), &ph, &CreateArgs::sol(sv::vault_pda(&ph).0), DEV_BUY);
    // [cu, create, ata, buy, register]
    let ixs = vec![ixs0[0].clone(), ixs0[1].clone(), ixs0[3].clone(), ixs0[4].clone(), ixs0[2].clone()];
    let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
    expect_custom_at(&r, 4, e::CURVE_NOT_FRESH);
}

// ---------------------------------------------------------------------------------------------- LCH-08

/// Real pump variants: mayhem create, holder-reward create (pump overrides the creator) and a USDC-quoted create.
#[test]
fn lch08_unsupported_pump_variants() {
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let vault = sv::vault_pda(&ph).0;
    let launcher = env.funded(5);
    let attestor = env.attestor.insecure_clone();

    // Mayhem mode (Global.mayhem_mode_enabled is on mainnet).
    let mint = Keypair::new();
    let mut a = CreateArgs::sol(vault);
    a.mayhem = true;
    let ixs = vec![cu_limit(800_000), create_v2(mint.pubkey(), launcher.pubkey(), &a), sv::register_launch(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey())];
    let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
    let (idx, err) = ix_err(&r);
    println!("LCH-08 mayhem create: ix {idx} {err:?}");
    assert_eq!((idx, err), (2, InstructionError::Custom(e::UNSUPPORTED_CURVE)), "{}", fail_str(r.as_ref().unwrap_err()));

    // Holder rewards (Global.is_holder_reward_enabled is on mainnet): pump sets creator = holder-rewards PDA, so
    // check 6 (creator) fires before check 7 (flags).
    let mint = Keypair::new();
    let mut a = CreateArgs::sol(vault);
    a.holder_reward = true;
    let ixs = vec![cu_limit(800_000), create_v2(mint.pubkey(), launcher.pubkey(), &a), sv::register_launch(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey())];
    let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
    let (idx, err) = ix_err(&r);
    println!("LCH-08 holder-reward create: ix {idx} {err:?}");
    assert_eq!((idx, err), (2, InstructionError::Custom(e::CREATOR_MISMATCH)), "{}", fail_str(r.as_ref().unwrap_err()));

    // USDC quote (Global.whitelisted_quote_mints[0]).
    let mint = Keypair::new();
    let mut a = CreateArgs::sol(vault);
    a.quote = Some((USDC, SPL_TOKEN));
    let ixs = vec![cu_limit(800_000), create_v2(mint.pubkey(), launcher.pubkey(), &a), sv::register_launch(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey())];
    let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
    let (idx, err) = ix_err(&r);
    println!("LCH-08 USDC-quoted create: ix {idx} {err:?}");
    assert_eq!((idx, err), (2, InstructionError::Custom(e::UNSUPPORTED_CURVE)), "{}", fail_str(r.as_ref().unwrap_err()));
}

/// Each flag of check 7 (and check 8) on an otherwise valid curve, by patching the real curve's bytes between a
/// plain `create_v2` and `register_launch` (simulates pump state the program must refuse).
#[test]
fn lch08b_each_curve_flag_is_refused() {
    let cases: &[(&str, usize, &[u8], u32)] = &[
        ("complete", 48, &[1], e::UNSUPPORTED_CURVE),
        ("mayhem", 81, &[1], e::UNSUPPORTED_CURVE),
        ("cashback", 82, &[1], e::UNSUPPORTED_CURVE),
        ("holder_reward", 124, &[1], e::UNSUPPORTED_CURVE),
        ("quote_mint=USDC", 83, USDC.as_ref(), e::UNSUPPORTED_CURVE),
        ("real_quote_reserves=1", 32, &[1, 0, 0, 0, 0, 0, 0, 0], e::CURVE_NOT_FRESH),
        ("discriminator", 0, &[0], e::INVALID_BONDING_CURVE),
    ];
    for (name, off, bytes, code) in cases {
        let mut env = Env::initialized();
        let ph = place_hash(PLACE);
        let launcher = env.funded(5);
        let mint = Keypair::new();
        ok(env.send(&[cu_limit(400_000), create_v2(mint.pubkey(), launcher.pubkey(), &CreateArgs::sol(sv::vault_pda(&ph).0))], &launcher, &[&mint]));
        let curve = bonding_curve(&mint.pubkey());
        let mut acc = env.account(&curve).unwrap();
        acc.data[*off..off + bytes.len()].copy_from_slice(bytes);
        env.svm.set_account(curve, acc).unwrap();
        let attestor = env.attestor.insecure_clone();
        let r = env.send(&[sv::register_launch(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey())], &launcher, &[&attestor]);
        println!("LCH-08b {name}");
        expect_custom(&r, *code);
        assert!(env.account(&sv::state_pda(&ph).0).is_none());
    }
    // quote_mint = WSOL is accepted as SOL (SDK isLegacyQuoteMint).
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let launcher = env.funded(5);
    let mint = Keypair::new();
    ok(env.send(&[cu_limit(400_000), create_v2(mint.pubkey(), launcher.pubkey(), &CreateArgs::sol(sv::vault_pda(&ph).0))], &launcher, &[&mint]));
    let curve = bonding_curve(&mint.pubkey());
    let mut acc = env.account(&curve).unwrap();
    acc.data[83..115].copy_from_slice(NATIVE_MINT.as_ref());
    env.svm.set_account(curve, acc).unwrap();
    let attestor = env.attestor.insecure_clone();
    ok(env.send(&[sv::register_launch(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey())], &launcher, &[&attestor]));
}

// ---------------------------------------------------------------------------------------------- LCH-09

#[test]
fn lch09_fake_or_foreign_bonding_curve() {
    let mut env = Env::initialized();
    let other = env.launch("other-place", DEV_BUY);
    let ph = place_hash(PLACE);
    let launcher = env.funded(5);
    let mint = Keypair::new();
    let attestor = env.attestor.insecure_clone();
    let real_bytes = env.account(&other.curve).unwrap().data;

    // A copy of real curve bytes (creator patched to our vault) in a system-owned and in a token-owned account at
    // a random address, a pump-owned copy at a random address, and the real curve of another mint.
    let mut patched = real_bytes.clone();
    patched[49..81].copy_from_slice(sv::vault_pda(&ph).0.as_ref());
    patched[32..40].copy_from_slice(&[0; 8]);
    let mut fakes = vec![];
    for owner in [sv::SYSTEM, SPL_TOKEN, PUMP] {
        let k = Address::new_unique();
        env.svm.set_account(k, Account { lamports: 10_000_000, data: patched.clone(), owner, executable: false, rent_epoch: 0 }).unwrap();
        fakes.push(k);
    }
    fakes.push(other.curve);
    for fake in fakes {
        let mut a = sv::RegisterAccounts::new(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey());
        a.bonding_curve = fake;
        let ixs = launch_with(&launcher.pubkey(), &mint.pubkey(), &ph, sv::register_launch_with(&a, &ph));
        let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
        expect_custom_at(&r, 2, e::INVALID_BONDING_CURVE);
    }
    // Pass the other coin's mint (its real curve then matches the PDA) but our place: creator mismatch.
    let mut a = sv::RegisterAccounts::new(launcher.pubkey(), attestor.pubkey(), &ph, other.mint);
    a.bonding_curve = other.curve;
    let r = env.send(&[sv::register_launch_with(&a, &ph)], &launcher, &[&attestor]);
    expect_custom(&r, e::CREATOR_MISMATCH);
}

// ---------------------------------------------------------------------------------------------- LCH-10

#[test]
fn lch10_non_canonical_state_or_vault() {
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let other_ph = place_hash("other-place");
    let launcher = env.funded(5);
    let mint = Keypair::new();
    let attestor = env.attestor.insecure_clone();
    // Non-canonical bump of the right seeds.
    let (canon, cb) = sv::state_pda(&ph);
    let noncanon = (0..cb)
        .rev()
        .find_map(|b| Address::create_program_address(&[b"vault_state", &ph, &[b]], &PROGRAM_ID).ok())
        .unwrap();
    assert_ne!(noncanon, canon);
    let (vcanon, vb) = sv::vault_pda(&ph);
    let vnoncanon = (0..vb).rev().find_map(|b| Address::create_program_address(&[b"vault", &ph, &[b]], &PROGRAM_ID).ok()).unwrap();

    type Mutate = Box<dyn Fn(&mut sv::RegisterAccounts)>;
    let cases: Vec<(Mutate, u32)> = vec![
        (Box::new(|a| a.vault_state = Address::new_unique()), e::INVALID_VAULT_STATE),
        (Box::new(move |a| a.vault_state = noncanon), e::INVALID_VAULT_STATE),
        (Box::new(move |a| a.vault_state = sv::state_pda(&other_ph).0), e::INVALID_VAULT_STATE),
        (Box::new(|a| a.vault = Address::new_unique()), e::INVALID_VAULT),
        (Box::new(move |a| a.vault = vnoncanon), e::INVALID_VAULT),
        (Box::new(move |a| a.vault = sv::vault_pda(&other_ph).0), e::INVALID_VAULT),
    ];
    for (mutate, code) in cases {
        let mut a = sv::RegisterAccounts::new(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey());
        mutate(&mut a);
        let ixs = launch_with(&launcher.pubkey(), &mint.pubkey(), &ph, sv::register_launch_with(&a, &ph));
        let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
        expect_custom_at(&r, 2, code);
    }
    // Read-only vault_state / vault.
    let mut reg = sv::register_launch(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey());
    set_meta(&mut reg, 3, canon, false, false);
    let r = fails_atomically(&mut env, &launch_with(&launcher.pubkey(), &mint.pubkey(), &ph, reg), &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
    expect_custom_at(&r, 2, e::ACCOUNT_NOT_WRITABLE);
    let mut reg = sv::register_launch(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey());
    set_meta(&mut reg, 4, vcanon, false, false);
    let r = fails_atomically(&mut env, &launch_with(&launcher.pubkey(), &mint.pubkey(), &ph, reg), &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
    expect_custom_at(&r, 2, e::INVALID_VAULT);
}

// ---------------------------------------------------------------------------------------------- LCH-11/12

#[test]
fn lch11_prefunded_vault_state_is_adopted_and_surplus_withdrawable() {
    for prefund in [1u64, LAMPORTS_PER_SOL] {
        let mut env = Env::initialized();
        let ph = place_hash(PLACE);
        let state = sv::state_pda(&ph).0;
        // A griefer pre-funds the PDA (set directly: 1 lamport is below rent, so a transfer could not create it).
        env.svm.set_account(state, Account { lamports: prefund, data: vec![], owner: sv::SYSTEM, executable: false, rent_epoch: 0 }).unwrap();
        let l = env.launch(PLACE, DEV_BUY);
        let sa = env.account(&state).unwrap();
        assert_eq!((sa.owner, sa.data.len()), (PROGRAM_ID, 208));
        assert_eq!(sa.lamports, prefund.max(env.rent(208)));
        assert_eq!(env.state(&ph).mint, l.mint);
        // The surplus over rent is withdrawable by the owner.
        let owner = env.claim_and_finalize(&ph);
        let surplus = prefund.saturating_sub(env.rent(208));
        let before = env.lamports(&owner.pubkey());
        let vault_extra = env.lamports(&l.vault) - env.rent(0);
        let r = env.send(&[sv::withdraw(owner.pubkey(), &ph)], &env.cranker.insecure_clone(), &[&owner]);
        if surplus + vault_extra == 0 {
            expect_custom(&r, e::NOTHING_TO_WITHDRAW);
        } else {
            ok(r);
            assert_eq!(env.lamports(&owner.pubkey()) - before, surplus + vault_extra);
            assert_eq!(env.lamports(&state), env.rent(208));
        }
    }
}

#[test]
fn lch12_prefunded_vault_keeps_its_balance() {
    for prefund in [1u64, 5 * LAMPORTS_PER_SOL] {
        let mut env = Env::initialized();
        let ph = place_hash(PLACE);
        let vault = sv::vault_pda(&ph).0;
        env.svm.set_account(vault, Account { lamports: prefund, data: vec![], owner: sv::SYSTEM, executable: false, rent_epoch: 0 }).unwrap();
        env.launch(PLACE, DEV_BUY);
        assert_eq!(env.lamports(&vault), prefund.max(env.rent(0)));
        assert_eq!(env.account(&vault).unwrap().owner, sv::SYSTEM);
    }
}

// ---------------------------------------------------------------------------------------------- LCH-13..16

#[test]
fn lch13_fake_system_program() {
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let launcher = env.funded(5);
    let mint = Keypair::new();
    let attestor = env.attestor.insecure_clone();
    let mut a = sv::RegisterAccounts::new(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey());
    a.system = SPL_TOKEN;
    let ixs = launch_with(&launcher.pubkey(), &mint.pubkey(), &ph, sv::register_launch_with(&a, &ph));
    let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
    expect_custom_at(&r, 2, e::INVALID_SYSTEM_PROGRAM);
}

#[test]
fn lch14_launcher_not_signer_or_not_writable() {
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let payer = env.funded(5); // create_v2 user and fee payer
    let launcher = env.funded(5); // named as launcher in register but does not sign
    let mint = Keypair::new();
    let attestor = env.attestor.insecure_clone();
    let mut reg = sv::register_launch(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey());
    set_meta(&mut reg, 0, launcher.pubkey(), false, true);
    let ixs = launch_with(&payer.pubkey(), &mint.pubkey(), &ph, reg);
    let r = fails_atomically(&mut env, &ixs, &payer, &[&mint, &attestor], &ph, &mint.pubkey());
    expect_ix(&r, InstructionError::MissingRequiredSignature);
    // Signer but read-only (not the fee payer).
    let mut reg = sv::register_launch(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey());
    set_meta(&mut reg, 0, launcher.pubkey(), true, false);
    let ixs = launch_with(&payer.pubkey(), &mint.pubkey(), &ph, reg);
    let r = fails_atomically(&mut env, &ixs, &payer, &[&mint, &attestor, &launcher], &ph, &mint.pubkey());
    expect_custom_at(&r, 2, e::ACCOUNT_NOT_WRITABLE);
}

#[test]
fn lch15_bad_data_length_or_discriminator() {
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let launcher = env.funded(5);
    let mint = Keypair::new();
    let attestor = env.attestor.insecure_clone();
    let good = sv::register_launch(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey());
    let mut datas = vec![good.data[..32].to_vec(), [good.data.clone(), vec![0]].concat(), vec![]];
    for d in [16u8, 99, 255] {
        let mut x = good.data.clone();
        x[0] = d;
        datas.push(x);
    }
    for d in datas {
        let mut reg = good.clone();
        reg.data = d.clone();
        let ixs = launch_with(&launcher.pubkey(), &mint.pubkey(), &ph, reg);
        let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
        expect_custom_at(&r, 2, e::INVALID_INSTRUCTION);
    }
    // Too few accounts (the 9th is the Instructions sysvar).
    for n in [7, 8] {
        let mut reg = good.clone();
        reg.accounts.truncate(n);
        let ixs = launch_with(&launcher.pubkey(), &mint.pubkey(), &ph, reg);
        let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
        expect_ix(&r, InstructionError::NotEnoughAccountKeys);
    }
}

/// Review finding R1 (attestor co-signature scope): register_launch must be the only top-level shop-vault
/// instruction of the launch tx and must get the real Instructions sysvar.
#[test]
fn lch18_register_launch_is_bound_to_its_own_tx() {
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let launcher = env.funded(5);
    let mint = Keypair::new();
    let attestor = env.attestor.insecure_clone();
    let grd = env.guardian.insecure_clone();
    // A fake Instructions sysvar.
    let mut a = sv::RegisterAccounts::new(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey());
    a.instructions = sv::SYSTEM;
    let ixs = launch_with(&launcher.pubkey(), &mint.pubkey(), &ph, sv::register_launch_with(&a, &ph));
    let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
    expect_custom_at(&r, 2, e::INVALID_INSTRUCTIONS_SYSVAR);
    // Any other shop-vault instruction anywhere in the tx (here a guardian unpause that is valid on its own).
    for at in [0usize, 5] {
        let mut ixs = env.launch_ixs(&launcher.pubkey(), &mint.pubkey(), &ph, &CreateArgs::sol(sv::vault_pda(&ph).0), DEV_BUY);
        ixs.insert(at, sv::set_paused(grd.pubkey(), 0));
        let reg_at = if at == 0 { 3 } else { 2 };
        let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor, &grd], &ph, &mint.pubkey());
        expect_custom_at(&r, reg_at, e::ATTESTOR_SCOPE);
    }
    // Two launches under one attestor signature.
    let ph2 = place_hash("lch18-second-place");
    let mint2 = Keypair::new();
    let mut ixs = env.launch_ixs(&launcher.pubkey(), &mint.pubkey(), &ph, &CreateArgs::sol(sv::vault_pda(&ph).0), 0);
    ixs.extend(env.launch_ixs(&launcher.pubkey(), &mint2.pubkey(), &ph2, &CreateArgs::sol(sv::vault_pda(&ph2).0), 0).into_iter().skip(1));
    let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &mint2, &attestor], &ph, &mint.pubkey());
    expect_custom_at(&r, 2, e::ATTESTOR_SCOPE);
    assert!(env.account(&mint2.pubkey()).is_none());
    // The plain launch still works.
    ok(env.try_launch(PLACE, &launcher, &mint, DEV_BUY));
}

#[test]
fn lch16_fake_config() {
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let launcher = env.funded(5);
    let mint = Keypair::new();
    let attestor = env.attestor.insecure_clone();
    let real = env.account(&sv::config_pda().0).unwrap();
    // Same bytes, other owners; and a program-owned account of the wrong kind (another VaultState).
    let other = env.launch("other-place", DEV_BUY);
    let mut fakes = vec![other.state];
    for owner in [sv::SYSTEM, PUMP] {
        let k = Address::new_unique();
        env.svm.set_account(k, Account { owner, ..real.clone() }).unwrap();
        fakes.push(k);
    }
    for fake in fakes {
        let mut a = sv::RegisterAccounts::new(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey());
        a.config = fake;
        let ixs = launch_with(&launcher.pubkey(), &mint.pubkey(), &ph, sv::register_launch_with(&a, &ph));
        let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
        expect_custom_at(&r, 2, e::INVALID_CONFIG);
    }
}

/// Uninitialized program: no Config yet → InvalidConfig.
#[test]
fn lch16b_launch_before_init() {
    let mut env = Env::new();
    let ph = place_hash(PLACE);
    let launcher = env.funded(5);
    let mint = Keypair::new();
    let attestor = env.attestor.insecure_clone();
    let ixs = env.launch_ixs(&launcher.pubkey(), &mint.pubkey(), &ph, &CreateArgs::sol(sv::vault_pda(&ph).0), DEV_BUY);
    let r = fails_atomically(&mut env, &ixs, &launcher, &[&mint, &attestor], &ph, &mint.pubkey());
    expect_custom_at(&r, 2, e::INVALID_CONFIG);
}

/// Extra trailing accounts are ignored (SPEC §5).
#[test]
fn lch17_extra_trailing_accounts_ignored() {
    let mut env = Env::initialized();
    let ph = place_hash(PLACE);
    let launcher = env.funded(5);
    let mint = Keypair::new();
    let attestor = env.attestor.insecure_clone();
    let mut reg = sv::register_launch(launcher.pubkey(), attestor.pubkey(), &ph, mint.pubkey());
    for _ in 0..5 {
        reg.accounts.push(AccountMeta::new_readonly(Address::new_unique(), false));
    }
    ok(env.send(&launch_with(&launcher.pubkey(), &mint.pubkey(), &ph, reg), &launcher, &[&mint, &attestor]));
    assert_eq!(env.state(&ph).mint, mint.pubkey());
}
