//! LiteSVM harness: the real mainnet pump.fun programs (tests/fixtures, dumped read-only by
//! scripts/dump-fixtures.sh) plus our `target/deploy/shop_vault.so`.
#![allow(dead_code, clippy::result_large_err)]

pub mod pump;
pub mod sv;

use std::{collections::HashMap, path::PathBuf, sync::OnceLock};

use base64::Engine;
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::{v0, AddressLookupTableAccount, Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::{versioned::VersionedTransaction, Transaction};
use solana_transaction_error::TransactionError;

pub use pump::*;
#[allow(unused_imports)]
pub use sv::{e, place_hash, role, ConfigView, StateView, PROGRAM_ID, WINDOW_72H};

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
/// 2026-10-08T00:00:00Z.
pub const START_TS: i64 = 1_791_417_600;
pub const START_SLOT: u64 = 454_533_828;
pub const COMPUTE_BUDGET: Address = solana_address::address!("ComputeBudget111111111111111111111111111111");
pub const ALT_PROGRAM: Address = solana_address::address!("AddressLookupTab1e1111111111111111111111111");

pub fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn fixtures() -> PathBuf {
    manifest_dir().join("tests/fixtures")
}

struct Fixtures {
    programs: Vec<(Address, Vec<u8>)>,
    accounts: Vec<(Address, Account)>,
    shop_vault: Vec<u8>,
    shop_vault_devnet: Option<Vec<u8>>,
}

fn load_fixtures() -> &'static Fixtures {
    static F: OnceLock<Fixtures> = OnceLock::new();
    F.get_or_init(|| {
        let dir = fixtures();
        let read = |name: &str| {
            std::fs::read(dir.join(name)).unwrap_or_else(|e| {
                panic!("missing fixture {name} ({e}); run programs/shop-vault/scripts/dump-fixtures.sh first")
            })
        };
        let programs = vec![
            (PUMP, read("pump.so")),
            (PUMP_FEES, read("pump_fees.so")),
            (MAYHEM, read("mayhem.so")),
            (PUMP_AMM, read("pump_amm.so")),
        ];
        let mut accounts = vec![];
        for entry in std::fs::read_dir(dir.join("accounts")).expect("tests/fixtures/accounts") {
            let path = entry.unwrap().path();
            let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let key: Address = v["pubkey"].as_str().unwrap().parse().unwrap();
            let a = &v["account"];
            let data = base64::engine::general_purpose::STANDARD.decode(a["data"][0].as_str().unwrap()).unwrap();
            accounts.push((
                key,
                Account {
                    lamports: a["lamports"].as_u64().unwrap(),
                    data,
                    owner: a["owner"].as_str().unwrap().parse().unwrap(),
                    executable: a["executable"].as_bool().unwrap(),
                    rent_epoch: 0,
                },
            ));
        }
        let so = std::env::var("SHOP_VAULT_SO")
            .map(PathBuf::from)
            .unwrap_or_else(|_| manifest_dir().join("target/deploy/shop_vault.so"));
        let shop_vault = std::fs::read(&so)
            .unwrap_or_else(|e| panic!("missing {} ({e}); run `cargo build-sbf` first", so.display()));
        // The devnet build has its own out dir (scripts/build.sh), never target/deploy.
        let shop_vault_devnet = std::fs::read(manifest_dir().join("target/deploy-devnet/shop_vault.so")).ok();
        Fixtures { programs, accounts, shop_vault, shop_vault_devnet }
    })
}

pub fn devnet_so_available() -> bool {
    load_fixtures().shop_vault_devnet.is_some()
}

pub struct Env {
    pub svm: LiteSVM,
    /// Upgrade authority of shop_vault (fabricated ProgramData).
    pub deployer: Keypair,
    /// Online co-signer of launches and claims (no other power).
    pub attestor: Keypair,
    pub governance: Keypair,
    /// Offline ops key: pause, bounded claim cancels, rotation veto/consent.
    pub guardian: Keypair,
    /// A funded stranger used as fee payer for permissionless steps.
    pub cranker: Keypair,
}

pub struct Launched {
    pub place_id: String,
    pub ph: [u8; 32],
    pub mint: Address,
    pub launcher: Keypair,
    pub vault: Address,
    pub state: Address,
    pub curve: Address,
    pub meta: TransactionMetadata,
}

impl Env {
    /// Programs and fixture accounts loaded; shop_vault deployed with `deployer` as upgrade authority; Config NOT
    /// initialized.
    pub fn new() -> Self {
        Self::with_program(false)
    }

    pub fn with_program(devnet: bool) -> Self {
        let f = load_fixtures();
        let mut svm = LiteSVM::new().with_transaction_history(10_000).with_log_bytes_limit(Some(100_000));
        let mut clock = svm.get_sysvar::<Clock>();
        clock.slot = START_SLOT;
        clock.unix_timestamp = START_TS;
        clock.epoch_start_timestamp = START_TS;
        svm.set_sysvar(&clock);
        for (id, bytes) in &f.programs {
            svm.add_program(*id, bytes).expect("load pump program");
        }
        let so = if devnet { f.shop_vault_devnet.as_ref().expect("target/deploy-devnet/shop_vault.so") } else { &f.shop_vault };
        svm.add_program(PROGRAM_ID, so).expect("load shop_vault");
        for (k, a) in &f.accounts {
            svm.set_account(*k, a.clone()).unwrap();
        }
        let deployer = Keypair::new();
        // Fabricate the ProgramData header: [3,0,0,0] slot:u64 Some(1) authority:32 (the program only reads it).
        let pd_key = sv::programdata_pda();
        let mut pd = svm.get_account(&pd_key).expect("programdata");
        pd.data[0..4].copy_from_slice(&[3, 0, 0, 0]);
        pd.data[12] = 1;
        pd.data[13..45].copy_from_slice(deployer.pubkey().as_ref());
        svm.set_account(pd_key, pd).unwrap();

        let env = Self {
            svm,
            deployer,
            attestor: Keypair::new(),
            governance: Keypair::new(),
            guardian: Keypair::new(),
            cranker: Keypair::new(),
        };
        let mut env = env;
        for k in [env.deployer.pubkey(), env.cranker.pubkey()] {
            env.svm.airdrop(&k, 100 * LAMPORTS_PER_SOL).unwrap();
        }
        env
    }

    /// Replaces the upgrade authority recorded in the fabricated ProgramData (and funds the new key).
    pub fn set_deployer(&mut self, deployer: Keypair) {
        let pd_key = sv::programdata_pda();
        let mut pd = self.svm.get_account(&pd_key).expect("programdata");
        pd.data[13..45].copy_from_slice(deployer.pubkey().as_ref());
        self.svm.set_account(pd_key, pd).unwrap();
        self.svm.airdrop(&deployer.pubkey(), 100 * LAMPORTS_PER_SOL).unwrap();
        self.deployer = deployer;
    }

    /// `new()` + `initialize_config(attestor, governance, guardian, 72 h)`.
    pub fn initialized() -> Self {
        let mut env = Self::new();
        env.init_config(WINDOW_72H).expect("initialize_config");
        env
    }

    pub fn init_config(&mut self, window: i64) -> TxResult {
        let ix = sv::initialize_config(
            self.deployer.pubkey(),
            self.attestor.pubkey(),
            self.governance.pubkey(),
            self.guardian.pubkey(),
            window,
        );
        let deployer = self.deployer.insecure_clone();
        self.send(&[ix], &deployer, &[])
    }

    pub fn funded(&mut self, sol: u64) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), sol * LAMPORTS_PER_SOL).unwrap();
        k
    }

    pub fn fund(&mut self, who: &Address, lamports: u64) {
        self.svm.airdrop(who, lamports).unwrap();
    }

    /// Legacy tx with a fresh blockhash; the blockhash is expired afterwards so identical later txs are not
    /// rejected as duplicates.
    pub fn send(&mut self, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) -> TxResult {
        let tx = self.tx(ixs, payer, extra);
        let r = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        r
    }

    /// Signs with the payer plus those `extra` keys the message actually requires (others are ignored).
    pub fn tx(&self, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) -> Transaction {
        let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &self.svm.latest_blockhash());
        let required = &msg.account_keys[..msg.header.num_required_signatures as usize];
        let mut signers: Vec<&Keypair> = vec![payer];
        for k in extra {
            if required.contains(&k.pubkey()) && !signers.iter().any(|s| s.pubkey() == k.pubkey()) {
                signers.push(k);
            }
        }
        let bh = self.svm.latest_blockhash();
        Transaction::new(&signers, msg, bh)
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    /// Moves the clock to `ts` (and the slot forward).
    pub fn set_time(&mut self, ts: i64) {
        let mut c = self.svm.get_sysvar::<Clock>();
        let dt = (ts - c.unix_timestamp).max(0) as u64;
        c.slot += 1 + dt * 5 / 2;
        c.unix_timestamp = ts;
        self.svm.set_sysvar(&c);
        self.svm.expire_blockhash();
    }

    pub fn warp(&mut self, secs: i64) {
        let t = self.now() + secs;
        self.set_time(t);
    }

    pub fn lamports(&self, a: &Address) -> u64 {
        self.svm.get_account(a).map(|x| x.lamports).unwrap_or(0)
    }

    pub fn account(&self, a: &Address) -> Option<Account> {
        self.svm.get_account(a)
    }

    pub fn rent(&self, len: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(len)
    }

    pub fn config(&self) -> ConfigView {
        let a = self.account(&sv::config_pda().0).expect("config");
        assert_eq!(a.owner, PROGRAM_ID);
        ConfigView::decode(&a.data)
    }

    pub fn state(&self, ph: &[u8; 32]) -> StateView {
        let a = self.account(&sv::state_pda(ph).0).expect("vault_state");
        assert_eq!(a.owner, PROGRAM_ID);
        StateView::decode(&a.data)
    }

    pub fn curve(&self, mint: &Address) -> Curve {
        Curve::decode(&self.account(&bonding_curve(mint)).expect("curve").data)
    }

    pub fn token_balance(&self, owner: &Address, mint: &Address) -> u64 {
        match self.account(&ata(owner, mint, &TOKEN_2022)) {
            Some(a) => u64::from_le_bytes(a.data[64..72].try_into().unwrap()),
            None => 0,
        }
    }

    /// Accounts snapshot for "a failing tx changed nothing" assertions.
    pub fn snapshot(&self, keys: &[Address]) -> Vec<Option<Account>> {
        keys.iter().map(|k| self.account(k)).collect()
    }

    // ------------------------------------------------------------------ launches

    /// The atomic launch instructions of SPEC §8.1: [CU limit, create_v2(creator = vault), register_launch,
    /// ATA create, buy_exact_quote_in_v3] (the last two only with a dev buy).
    pub fn launch_ixs(&self, launcher: &Address, mint: &Address, ph: &[u8; 32], create: &CreateArgs, dev_buy: u64) -> Vec<Instruction> {
        let mut ixs = vec![cu_limit(600_000), create_v2(*mint, *launcher, create)];
        ixs.push(sv::register_launch(*launcher, self.attestor.pubkey(), ph, *mint));
        if dev_buy > 0 {
            ixs.push(create_ata_idempotent(*launcher, *launcher, *mint, TOKEN_2022));
            ixs.push(buy_exact_quote_in_v3(*launcher, *mint, dev_buy, 1));
        }
        ixs
    }

    pub fn try_launch(&mut self, place_id: &str, launcher: &Keypair, mint: &Keypair, dev_buy: u64) -> TxResult {
        let ph = place_hash(place_id);
        let create = CreateArgs::sol(sv::vault_pda(&ph).0);
        let ixs = self.launch_ixs(&launcher.pubkey(), &mint.pubkey(), &ph, &create, dev_buy);
        let attestor = self.attestor.insecure_clone();
        self.send(&ixs, launcher, &[mint, &attestor])
    }

    pub fn launch(&mut self, place_id: &str, dev_buy: u64) -> Launched {
        let launcher = self.funded(10);
        let mint = Keypair::new();
        let meta = self.try_launch(place_id, &launcher, &mint, dev_buy).unwrap_or_else(|f| panic!("launch failed: {}", fail_str(&f)));
        let ph = place_hash(place_id);
        Launched {
            place_id: place_id.to_string(),
            ph,
            mint: mint.pubkey(),
            launcher,
            vault: sv::vault_pda(&ph).0,
            state: sv::state_pda(&ph).0,
            curve: bonding_curve(&mint.pubkey()),
            meta,
        }
    }

    // ------------------------------------------------------------------ trading and fees

    /// v3 buy of exactly `lamports` (fees included) by `trader`; returns the TradeEvents.
    pub fn buy_v3(&mut self, trader: &Keypair, mint: &Address, lamports: u64) -> Vec<TradeEvent> {
        let ixs = vec![
            cu_limit(400_000),
            create_ata_idempotent(trader.pubkey(), trader.pubkey(), *mint, TOKEN_2022),
            buy_exact_quote_in_v3(trader.pubkey(), *mint, lamports, 1),
        ];
        let m = self.send(&ixs, trader, &[]).unwrap_or_else(|f| panic!("buy_v3: {}", fail_str(&f)));
        trade_events(&m)
    }

    pub fn sell_v3(&mut self, trader: &Keypair, mint: &Address, amount: u64) -> Vec<TradeEvent> {
        let ixs = vec![cu_limit(400_000), sell_v3(trader.pubkey(), *mint, amount, 0)];
        let m = self.send(&ixs, trader, &[]).unwrap_or_else(|f| panic!("sell_v3: {}", fail_str(&f)));
        trade_events(&m)
    }

    pub fn buy_v2(&mut self, trader: &Keypair, mint: &Address, creator: &Address, tokens: u64, max_cost: u64) -> Vec<TradeEvent> {
        let ixs = vec![
            cu_limit(400_000),
            create_ata_idempotent(trader.pubkey(), trader.pubkey(), *mint, TOKEN_2022),
            buy_v2(trader.pubkey(), *mint, *creator, tokens, max_cost),
        ];
        let m = self.send(&ixs, trader, &[]).unwrap_or_else(|f| panic!("buy_v2: {}", fail_str(&f)));
        trade_events(&m)
    }

    pub fn sell_v2(&mut self, trader: &Keypair, mint: &Address, creator: &Address, amount: u64) -> Vec<TradeEvent> {
        let ixs = vec![cu_limit(400_000), sell_v2(trader.pubkey(), *mint, *creator, amount, 0)];
        let m = self.send(&ixs, trader, &[]).unwrap_or_else(|f| panic!("sell_v2: {}", fail_str(&f)));
        trade_events(&m)
    }

    /// Permissionless [sweep_creator_fee, collect_creator_fee(creator = vault)] paid by the cranker.
    pub fn sweep_and_collect(&mut self, mint: &Address, vault: &Address) -> TransactionMetadata {
        let cranker = self.cranker.insecure_clone();
        let ixs = vec![
            cu_limit(200_000),
            sweep_creator_fee(cranker.pubkey(), *mint, *vault),
            collect_creator_fee(*vault),
        ];
        self.send(&ixs, &cranker, &[]).unwrap_or_else(|f| panic!("sweep+collect: {}", fail_str(&f)))
    }

    // ------------------------------------------------------------------ claims

    pub fn request_claim(&mut self, ph: &[u8; 32], new_owner: &Keypair, nonce: u64) -> TxResult {
        let ix = sv::request_claim(self.attestor.pubkey(), new_owner.pubkey(), ph, nonce);
        let attestor = self.attestor.insecure_clone();
        self.send(&[ix], new_owner, &[&attestor])
    }

    /// request_claim → warp past the window → finalize_claim. Returns the new owner.
    pub fn claim_and_finalize(&mut self, ph: &[u8; 32]) -> Keypair {
        let owner = self.funded(1);
        let nonce = self.state(ph).claim_nonce + 1;
        self.request_claim(ph, &owner, nonce).unwrap_or_else(|f| panic!("request_claim: {}", fail_str(&f)));
        let unlock = self.state(ph).unlock_ts;
        self.set_time(unlock);
        let cranker = self.cranker.insecure_clone();
        self.send(&[sv::finalize_claim(ph)], &cranker, &[]).unwrap_or_else(|f| panic!("finalize: {}", fail_str(&f)));
        owner
    }

    // ------------------------------------------------------------------ lookup table

    /// Writes an active, frozen ALT holding `addresses` (authority None) directly into the bank.
    pub fn put_alt(&mut self, key: Address, addresses: &[Address]) -> AddressLookupTableAccount {
        let mut d = Vec::with_capacity(56 + 32 * addresses.len());
        d.extend_from_slice(&1u32.to_le_bytes()); // ProgramState::LookupTable
        d.extend_from_slice(&u64::MAX.to_le_bytes()); // deactivation_slot
        d.extend_from_slice(&0u64.to_le_bytes()); // last_extended_slot
        d.push(0); // last_extended_slot_start_index
        d.push(0); // authority: None (frozen)
        d.extend_from_slice(&[0u8; 32]);
        d.extend_from_slice(&[0u8; 2]); // padding -> 56-byte meta
        assert_eq!(d.len(), 56);
        for a in addresses {
            d.extend_from_slice(a.as_ref());
        }
        let lamports = self.rent(d.len());
        self.svm
            .set_account(key, Account { lamports, data: d, owner: ALT_PROGRAM, executable: false, rent_epoch: 0 })
            .unwrap();
        AddressLookupTableAccount { key, addresses: addresses.to_vec() }
    }

    pub fn v0_tx(&self, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair], alts: &[AddressLookupTableAccount]) -> VersionedTransaction {
        let msg = v0::Message::try_compile(&payer.pubkey(), ixs, alts, self.svm.latest_blockhash()).unwrap();
        let mut signers: Vec<&Keypair> = vec![payer];
        signers.extend_from_slice(extra);
        VersionedTransaction::try_new(VersionedMessage::V0(msg), &signers).unwrap()
    }
}

pub fn cu_limit(units: u32) -> Instruction {
    let mut d = vec![2u8];
    d.extend_from_slice(&units.to_le_bytes());
    Instruction { program_id: COMPUTE_BUDGET, accounts: vec![], data: d }
}

pub fn cu_price(micro_lamports: u64) -> Instruction {
    let mut d = vec![3u8];
    d.extend_from_slice(&micro_lamports.to_le_bytes());
    Instruction { program_id: COMPUTE_BUDGET, accounts: vec![], data: d }
}

pub fn system_transfer(from: Address, to: Address, lamports: u64) -> Instruction {
    let mut d = 2u32.to_le_bytes().to_vec();
    d.extend_from_slice(&lamports.to_le_bytes());
    Instruction { program_id: sv::SYSTEM, accounts: vec![AccountMeta::new(from, true), AccountMeta::new(to, false)], data: d }
}

/// Serialized size of a versioned tx (signatures short-vec + 64 B each + message).
pub fn tx_size(tx: &VersionedTransaction) -> usize {
    let msg = tx.message.serialize();
    short_vec_len(tx.signatures.len()) + 64 * tx.signatures.len() + msg.len()
}

pub fn legacy_tx_size(tx: &Transaction) -> usize {
    let msg = tx.message.serialize();
    short_vec_len(tx.signatures.len()) + 64 * tx.signatures.len() + msg.len()
}

fn short_vec_len(n: usize) -> usize {
    if n < 0x80 {
        1
    } else if n < 0x4000 {
        2
    } else {
        3
    }
}

pub fn trade_events(m: &TransactionMetadata) -> Vec<TradeEvent> {
    m.inner_instructions
        .iter()
        .flatten()
        .filter_map(|ix| TradeEvent::try_decode(&ix.instruction.data))
        .collect()
}

/// shop_vault `sol_log_data` events (base64 segments) from the logs, by name.
pub fn program_events(m: &TransactionMetadata, name: &str) -> Vec<Vec<Vec<u8>>> {
    let eng = base64::engine::general_purpose::STANDARD;
    m.logs
        .iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .map(|s| s.split(' ').map(|p| eng.decode(p).unwrap()).collect::<Vec<_>>())
        .filter(|segs| segs.first().map(|n| n.as_slice() == name.as_bytes()).unwrap_or(false))
        .collect()
}

pub fn fail_str(f: &FailedTransactionMetadata) -> String {
    format!("{:?}\n{}", f.err, f.meta.logs.join("\n"))
}

/// The instruction error of a failed tx.
pub fn ix_err(r: &TxResult) -> (u8, InstructionError) {
    match r {
        Ok(m) => panic!("expected failure, tx succeeded:\n{}", m.logs.join("\n")),
        Err(f) => match &f.err {
            TransactionError::InstructionError(i, e) => (*i, e.clone()),
            other => panic!("expected an instruction error, got {other:?}\n{}", f.meta.logs.join("\n")),
        },
    }
}

#[track_caller]
pub fn expect_custom(r: &TxResult, code: u32) {
    let (_, err) = ix_err(r);
    if err != InstructionError::Custom(code) {
        panic!("expected Custom({code}), got {err:?}\n{}", r.as_ref().err().unwrap().meta.logs.join("\n"));
    }
}

#[track_caller]
pub fn expect_ix(r: &TxResult, want: InstructionError) {
    let (_, err) = ix_err(r);
    if err != want {
        panic!("expected {want:?}, got {err:?}\n{}", r.as_ref().err().unwrap().meta.logs.join("\n"));
    }
}

/// Expect a failure in instruction `idx` with a custom (program-specific) code.
#[track_caller]
pub fn expect_custom_at(r: &TxResult, idx: u8, code: u32) {
    let (i, err) = ix_err(r);
    if (i, err.clone()) != (idx, InstructionError::Custom(code)) {
        panic!("expected ix {idx} Custom({code}), got ix {i} {err:?}\n{}", r.as_ref().err().unwrap().meta.logs.join("\n"));
    }
}

#[track_caller]
pub fn expect_tx_err(r: &TxResult, want: TransactionError) {
    match r {
        Ok(_) => panic!("expected {want:?}, tx succeeded"),
        Err(f) => assert_eq!(f.err, want, "{}", f.meta.logs.join("\n")),
    }
}

#[track_caller]
pub fn ok(r: TxResult) -> TransactionMetadata {
    r.unwrap_or_else(|f| panic!("tx failed: {}", fail_str(&f)))
}

/// Compute units consumed by the shop_vault instruction(s) in a tx (from "consumed" log lines).
pub fn shop_vault_cu(m: &TransactionMetadata) -> Vec<u64> {
    let needle = format!("Program {} consumed ", PROGRAM_ID);
    m.logs
        .iter()
        .filter_map(|l| l.strip_prefix(&needle))
        .map(|rest| rest.split(' ').next().unwrap().parse().unwrap())
        .collect()
}

/// Counts of lamport-holding accounts by key, for conservation checks.
pub fn balances(env: &Env, keys: &[Address]) -> HashMap<Address, u64> {
    keys.iter().map(|k| (*k, env.lamports(k))).collect()
}
