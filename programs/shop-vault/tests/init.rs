//! INIT-*: `initialize_config`, locked to the upgrade authority (SPEC §5.0); BLD-01 size gate.
#![allow(clippy::result_large_err, deprecated)]
mod common;

use common::*;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn init_ix(env: &Env, window: i64) -> Instruction {
    sv::initialize_config(env.deployer.pubkey(), env.attestor.pubkey(), env.governance.pubkey(), env.guardian.pubkey(), window)
}

#[track_caller]
fn fails_uninitialized(env: &mut Env, ix: Instruction, payer: &Keypair, extra: &[&Keypair]) -> TxResult {
    let r = env.send(&[ix], payer, extra);
    assert!(r.is_err());
    let cfg = env.account(&sv::config_pda().0);
    assert!(cfg.map(|a| a.owner != PROGRAM_ID).unwrap_or(true), "config must stay uninitialized");
    r
}

#[test]
fn init01_happy() {
    let mut env = Env::new();
    let m = ok(env.init_config(WINDOW_72H));
    let (key, bump) = sv::config_pda();
    let a = env.account(&key).unwrap();
    assert_eq!((a.owner, a.data.len(), a.lamports), (PROGRAM_ID, 256, env.rent(256)));
    let c = env.config();
    assert_eq!((c.tag, c.version, c.bump, c.paused, c.flavor, c.flags), (1, 1, bump, 0, 0, 0));
    assert_eq!(c.attestor, env.attestor.pubkey());
    assert_eq!(c.governance, env.governance.pubkey());
    assert_eq!(c.guardian, env.guardian.pubkey());
    assert_eq!((c.pending_attestor, c.pending_attestor_eta, c.pending_governance), (Address::default(), 0, Address::default()));
    assert_eq!((c.pending_guardian, c.pending_guardian_eta, c.pending_governance_eta), (Address::default(), 0, 0));
    assert_eq!((c.claim_window_secs, c.probation_until, c.rotation_delay_secs), (WINDOW_72H, 0, sv::ROTATION_DELAY));
    let ev = program_events(&m, "ConfigInitialized");
    assert_eq!(ev[0][1], env.attestor.pubkey().as_ref().to_vec());
    assert_eq!(ev[0][2], env.governance.pubkey().as_ref().to_vec());
    assert_eq!(ev[0][3], env.guardian.pubkey().as_ref().to_vec());
    assert_eq!(ev[0][4], WINDOW_72H.to_le_bytes().to_vec());
    assert_eq!(ev[0][5], b"shop-vault-build:mainnet".to_vec(), "build flavour recorded (R2-A3)");
    assert_eq!(ev[0][6], sv::ROTATION_DELAY.to_le_bytes().to_vec());
    let cu = shop_vault_cu(&m)[0];
    println!("initialize_config CU {cu}");
    assert!(cu <= 25_000, "init CU {cu}");
}

#[test]
fn init02_signer_is_not_the_upgrade_authority() {
    let mut env = Env::new();
    let attacker = env.funded(5);
    let ix = sv::initialize_config(attacker.pubkey(), attacker.pubkey(), Keypair::new().pubkey(), Keypair::new().pubkey(), WINDOW_72H);
    let r = fails_uninitialized(&mut env, ix, &attacker, &[]);
    expect_custom(&r, e::NOT_UPGRADE_AUTHORITY);
}

#[test]
fn init03_programdata_checks() {
    // Wrong programdata address (another program's, and a random account).
    let mut env = Env::new();
    let deployer = env.deployer.insecure_clone();
    for bad in [Address::find_program_address(&[PUMP.as_ref()], &sv::BPF_UPGRADEABLE).0, Address::new_unique()] {
        let mut ix = init_ix(&env, WINDOW_72H);
        ix.accounts[2].pubkey = bad;
        expect_custom(&fails_uninitialized(&mut env, ix, &deployer, &[]), e::NOT_UPGRADE_AUTHORITY);
    }
    // Patched ProgramData at the right address: wrong owner, tag != 3, authority None, other authority, too short.
    let pd = sv::programdata_pda();
    let real = env.account(&pd).unwrap();
    let mut variants: Vec<Account> = vec![];
    variants.push(Account { owner: sv::SYSTEM, ..real.clone() });
    let mut t = real.clone();
    t.data[0] = 2;
    variants.push(t);
    let mut none = real.clone();
    none.data[12] = 0;
    variants.push(none);
    let mut other = real.clone();
    other.data[13..45].copy_from_slice(Keypair::new().pubkey().as_ref());
    variants.push(other);
    variants.push(Account { data: real.data[..44].to_vec(), ..real.clone() });
    for v in variants {
        let mut env = Env::new();
        env.svm.set_account(pd, v).unwrap();
        let deployer = env.deployer.insecure_clone();
        let ix = init_ix(&env, WINDOW_72H);
        expect_custom(&fails_uninitialized(&mut env, ix, &deployer, &[]), e::NOT_UPGRADE_AUTHORITY);
    }
}

#[test]
fn init04_second_init() {
    let mut env = Env::initialized();
    let before = env.account(&sv::config_pda().0);
    let r = env.init_config(WINDOW_72H);
    expect_custom(&r, e::ALREADY_INITIALIZED);
    assert_eq!(env.account(&sv::config_pda().0), before);
}

#[test]
fn init05_window_bounds_mainnet_build() {
    let deployer_bad = [0i64, 59, 60, 3_600, WINDOW_72H - 1, 2_592_001, i64::MAX, -1, i64::MIN];
    for w in deployer_bad {
        let mut env = Env::new();
        let deployer = env.deployer.insecure_clone();
        let ix = init_ix(&env, w);
        expect_custom(&fails_uninitialized(&mut env, ix, &deployer, &[]), e::INVALID_WINDOW);
    }
    for w in [WINDOW_72H, 2_592_000] {
        let mut env = Env::new();
        ok(env.init_config(w));
        assert_eq!(env.config().claim_window_secs, w);
    }
}

#[test]
fn init05b_window_bounds_devnet_build() {
    assert!(devnet_so_available(), "target/deploy-devnet/shop_vault.so missing: run scripts/build.sh");
    // The devnet MAX (24 h) is below the mainnet MIN (72 h): the mainnet runbook value is refused (R2-A3).
    for (w, good) in [(59i64, false), (60, true), (86_400, true), (86_401, false), (WINDOW_72H, false), (2_592_000, false)] {
        let mut env = Env::with_program(true);
        let r = env.init_config(w);
        if good {
            ok(r);
            let c = env.config();
            assert_eq!((c.flavor, c.rotation_delay_secs), (1, sv::DEVNET_ROTATION_DELAY), "devnet build recorded in Config");
        } else {
            expect_custom(&r, e::INVALID_WINDOW);
        }
    }
    // Devnet: 60 s claim window and 300 s rotation delay, end to end.
    let mut env = Env::with_program(true);
    let m = ok(env.init_config(60));
    assert_eq!(program_events(&m, "ConfigInitialized")[0][5], b"shop-vault-build:devnet".to_vec());
    let l = env.launch("cornershop-test:cafe-1", 10_000_000);
    let owner = env.funded(1);
    let t0 = env.now();
    ok(env.request_claim(&l.ph, &owner, 1));
    assert_eq!(env.state(&l.ph).unlock_ts, t0 + 60);
    let cranker = env.cranker.insecure_clone();
    env.warp(59);
    expect_custom(&env.send(&[sv::finalize_claim(&l.ph)], &cranker, &[]), e::CLAIM_WINDOW_ACTIVE);
    env.warp(1);
    ok(env.send(&[sv::finalize_claim(&l.ph)], &cranker, &[]));
    let gov = env.governance.insecure_clone();
    let new = Keypair::new();
    let t1 = env.now();
    ok(env.send(&[sv::propose_attestor(gov.pubkey(), new.pubkey())], &cranker, &[&gov]));
    assert_eq!(env.config().pending_attestor_eta, t1 + 300);
}

#[test]
fn init06_authority_keys() {
    // Attestor, governance and guardian must be non-zero and pairwise distinct.
    let (a, b, c, z) = (Keypair::new().pubkey(), Keypair::new().pubkey(), Keypair::new().pubkey(), Address::default());
    for (att, gov, grd) in [(z, b, c), (a, z, c), (a, b, z), (a, a, c), (a, b, a), (a, b, b), (z, z, z)] {
        let mut env = Env::new();
        let deployer = env.deployer.insecure_clone();
        let ix = sv::initialize_config(deployer.pubkey(), att, gov, grd, WINDOW_72H);
        expect_custom(&fails_uninitialized(&mut env, ix, &deployer, &[]), e::INVALID_AUTHORITY_KEY);
    }
}

#[test]
fn init07_prefunded_config_is_adopted() {
    for pre in [1u64, LAMPORTS_PER_SOL] {
        let mut env = Env::new();
        let key = sv::config_pda().0;
        env.svm.set_account(key, Account { lamports: pre, data: vec![], owner: sv::SYSTEM, executable: false, rent_epoch: 0 }).unwrap();
        ok(env.init_config(WINDOW_72H));
        let a = env.account(&key).unwrap();
        assert_eq!((a.owner, a.data.len(), a.lamports), (PROGRAM_ID, 256, pre.max(env.rent(256))));
        assert_eq!(env.config().attestor, env.attestor.pubkey());
    }
}

#[test]
fn init08_config_signer_and_system_program_checks() {
    let mut env = Env::new();
    let deployer = env.deployer.insecure_clone();
    // Wrong config address.
    let mut ix = init_ix(&env, WINDOW_72H);
    ix.accounts[1].pubkey = Address::new_unique();
    expect_custom(&fails_uninitialized(&mut env, ix, &deployer, &[]), e::INVALID_CONFIG);
    // Upgrade authority listed but not signing (someone else pays).
    let payer = env.funded(2);
    let mut ix = init_ix(&env, WINDOW_72H);
    ix.accounts[0].is_signer = false;
    expect_ix(&fails_uninitialized(&mut env, ix, &payer, &[]), InstructionError::MissingRequiredSignature);
    // Signing but read-only.
    let mut ix = init_ix(&env, WINDOW_72H);
    ix.accounts[0].is_writable = false;
    expect_custom(&fails_uninitialized(&mut env, ix, &payer, &[&deployer]), e::ACCOUNT_NOT_WRITABLE);
    // Read-only config.
    let mut ix = init_ix(&env, WINDOW_72H);
    ix.accounts[1].is_writable = false;
    expect_custom(&fails_uninitialized(&mut env, ix, &deployer, &[]), e::ACCOUNT_NOT_WRITABLE);
    // Fake system program.
    let mut ix = init_ix(&env, WINDOW_72H);
    ix.accounts[3].pubkey = SPL_TOKEN;
    expect_custom(&fails_uninitialized(&mut env, ix, &deployer, &[]), e::INVALID_SYSTEM_PROGRAM);
    // Bad data.
    let mut ix = init_ix(&env, WINDOW_72H);
    ix.data.pop();
    expect_custom(&fails_uninitialized(&mut env, ix, &deployer, &[]), e::INVALID_INSTRUCTION);
    let mut ix = init_ix(&env, WINDOW_72H);
    ix.accounts.truncate(3);
    expect_ix(&fails_uninitialized(&mut env, ix, &deployer, &[]), InstructionError::NotEnoughAccountKeys);
    ok(env.init_config(WINDOW_72H));
}

/// BLD-01: both builds are under 40 KB, and each carries only its own build-flavour marker (R2-A3).
#[test]
fn bld01_program_size_under_40kb() {
    let main = std::fs::read(manifest_dir().join("target/deploy/shop_vault.so")).unwrap();
    let dev = std::fs::read(manifest_dir().join("target/deploy-devnet/shop_vault.so")).expect("run scripts/build.sh");
    println!("target/deploy/shop_vault.so {} B, target/deploy-devnet/shop_vault.so {} B", main.len(), dev.len());
    assert!(main.len() < 40_960 && dev.len() < 40_960);
    let has = |so: &[u8], m: &[u8]| so.windows(m.len()).any(|w| w == m);
    assert!(has(&main, b"shop-vault-build:mainnet") && !has(&main, b"shop-vault-build:devnet"));
    assert!(has(&dev, b"shop-vault-build:devnet") && !has(&dev, b"shop-vault-build:mainnet"));
    assert!(!manifest_dir().join("target/deploy/shop_vault-devnet.so").exists(), "no devnet artifact in target/deploy");
}

/// Unknown discriminators and empty data.
#[test]
fn bld02_unknown_instruction() {
    let mut env = Env::initialized();
    let payer = env.funded(1);
    for d in [vec![], vec![16], vec![200, 1, 2, 3]] {
        let ix = sv::ix(vec![], d);
        expect_custom(&env.send(&[ix], &payer, &[]), e::INVALID_INSTRUCTION);
    }
}
