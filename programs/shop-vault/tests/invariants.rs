//! INV-01: a seeded random walk of 2,000 operations over 3 places against a reference model of SPEC §5 (including the
//! guardian / governance cancel roles, the per-place solo-cancel budget, and the probation after attestor changes).
//! After every step: the on-chain VaultState equals the model (I3, I4), lamports only leave vault/state in a
//! successful withdraw and only to the owner (I1, I2, I8), pause only affects launches (I6), and conservation holds:
//! Σ withdrawn + Σ (vault − rent_min(0)) + Σ (state − rent_min(208)) == Σ inflow.
#![allow(clippy::result_large_err, deprecated)]
mod common;

use common::*;
use rand::{rngs::StdRng, Rng, SeedableRng};
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;

const STEPS: usize = 2_000;
const SEED: u64 = 0x00C0_FFEE_5EED;

struct Place {
    ph: [u8; 32],
    mint: Address,
    vault: Address,
    state: Address,
    // model
    owner: Option<Address>,
    /// (claimant, unlock_ts, requested during probation)
    pending: Option<(Address, i64, bool)>,
    governance_cancels: u8,
    nonce: u64,
    withdrawn: u64,
    inflow: u64,
}

#[derive(Debug, PartialEq)]
enum Expect {
    Ok,
    Err(u32),
}

struct Walk {
    env: Env,
    rng: StdRng,
    places: Vec<Place>,
    people: Vec<Keypair>,
    old_attestors: Vec<Keypair>,
    trader: Keypair,
    paused: bool,
    probation_until: i64,
    rent0: u64,
    rent_s: u64,
    stats: std::collections::BTreeMap<&'static str, (u32, u32)>,
}

impl Walk {
    fn attestor(&self) -> Keypair {
        self.env.attestor.insecure_clone()
    }
    fn governance(&self) -> Keypair {
        self.env.governance.insecure_clone()
    }
    fn guardian(&self) -> Keypair {
        self.env.guardian.insecure_clone()
    }
    fn person(&mut self) -> Keypair {
        let i = self.rng.gen_range(0..self.people.len());
        self.people[i].insecure_clone()
    }

    /// Sends a tx paid by the cranker and checks the outcome against the model's expectation; on failure, asserts
    /// that the place's accounts and Config are unchanged.
    fn exec(&mut self, name: &'static str, p: usize, ixs: &[Instruction], signers: &[&Keypair], want: Expect) -> Option<litesvm::types::TransactionMetadata> {
        let keys = [self.places[p].state, self.places[p].vault, sv::config_pda().0];
        let before = self.env.snapshot(&keys);
        let cranker = self.env.cranker.insecure_clone();
        let r = self.env.send(ixs, &cranker, signers);
        let e = self.stats.entry(name).or_default();
        match (&r, &want) {
            (Ok(m), Expect::Ok) => {
                e.0 += 1;
                Some(m.clone())
            }
            (Err(_), Expect::Err(code)) => {
                e.1 += 1;
                expect_custom(&r, *code);
                assert_eq!(self.env.snapshot(&keys), before, "{name}: failed tx changed state");
                None
            }
            (Ok(_), Expect::Err(code)) => panic!("{name}: expected Custom({code}) but succeeded"),
            (Err(f), Expect::Ok) => panic!("{name}: expected success, got {}", fail_str(f)),
        }
    }

    fn check(&self, step: usize) {
        for (i, p) in self.places.iter().enumerate() {
            let st = self.env.state(&p.ph);
            assert_eq!(st.place_hash, p.ph, "I4 step {step} place {i}");
            assert_eq!(st.mint, p.mint, "I4 step {step} place {i}");
            assert_eq!(st.has_owner, p.owner.is_some(), "I3 step {step} place {i}");
            assert_eq!(st.owner, p.owner.unwrap_or_default(), "I3 step {step} place {i}");
            assert_eq!(st.has_pending, p.pending.is_some(), "step {step} place {i}");
            assert_eq!(st.pending_owner, p.pending.map(|x| x.0).unwrap_or_default());
            assert_eq!(st.unlock_ts, p.pending.map(|x| x.1).unwrap_or(0));
            assert_eq!(st.pending_flags, p.pending.map(|x| x.2 as u8).unwrap_or(0), "probation flag step {step}");
            assert_eq!(st.governance_cancels, p.governance_cancels, "governance cancel budget step {step}");
            assert_eq!(st.claim_nonce, p.nonce);
            assert_eq!(st.total_withdrawn, p.withdrawn, "step {step} place {i}");
            let v = self.env.lamports(&p.vault);
            let s = self.env.lamports(&p.state);
            assert!(v >= self.rent0 && s >= self.rent_s, "rent floor step {step}");
            let va = self.env.account(&p.vault).unwrap();
            assert_eq!((va.owner, va.data.len()), (sv::SYSTEM, 0), "vault stays a system wallet");
            assert_eq!(
                p.withdrawn + (v - self.rent0) + (s - self.rent_s),
                p.inflow,
                "conservation step {step} place {i}"
            );
        }
        assert_eq!(self.env.config().paused, self.paused as u8);
        assert_eq!(self.env.config().probation_until, self.probation_until);
    }
}

#[test]
fn inv01_random_walk() {
    let mut env = Env::initialized();
    let mut places = vec![];
    for i in 0..3 {
        let l = env.launch(&format!("inv-place-{i}"), 0);
        places.push(Place {
            ph: l.ph,
            mint: l.mint,
            vault: l.vault,
            state: l.state,
            owner: None,
            pending: None,
            governance_cancels: 0,
            nonce: 0,
            withdrawn: 0,
            inflow: 0,
        });
    }
    let people: Vec<Keypair> = (0..5).map(|_| Keypair::new()).collect();
    let trader = env.funded(20_000);
    let rent0 = env.rent(0);
    let rent_s = env.rent(208);
    let mut w = Walk {
        env,
        rng: StdRng::seed_from_u64(SEED),
        places,
        people,
        old_attestors: vec![],
        trader,
        paused: false,
        probation_until: 0,
        rent0,
        rent_s,
        stats: Default::default(),
    };
    w.check(0);

    for step in 1..=STEPS {
        let p = w.rng.gen_range(0..w.places.len());
        let op = w.rng.gen_range(0..100u32);
        let window = WINDOW_72H;
        match op {
            // Direct donation to the vault, or stray SOL to the state PDA.
            0..=9 => {
                let amount = w.rng.gen_range(1_000..2 * LAMPORTS_PER_SOL);
                let to = if op < 7 { w.places[p].vault } else { w.places[p].state };
                let funder = w.env.funded(3);
                ok(w.env.send(&[system_transfer(funder.pubkey(), to, amount)], &funder, &[]));
                w.places[p].inflow += amount;
                w.stats.entry("donate").or_default().0 += 1;
            }
            // Real pump trade(s) + permissionless sweep/collect.
            10..=15 => {
                let mint = w.places[p].mint;
                let vault = w.places[p].vault;
                let trader = w.trader.insecure_clone();
                let mut evs = w.env.buy_v3(&trader, &mint, w.rng.gen_range(1_000_000..LAMPORTS_PER_SOL));
                let bal = w.env.token_balance(&trader.pubkey(), &mint);
                if bal > 0 && w.rng.gen_bool(0.5) {
                    evs.extend(w.env.sell_v3(&trader, &mint, bal / 3));
                }
                let v0 = w.env.lamports(&vault);
                w.env.sweep_and_collect(&mint, &vault);
                let delta = w.env.lamports(&vault) - v0;
                assert_eq!(delta, evs.iter().map(|e| e.creator_fee).sum::<u64>(), "collect == Σ creator fees");
                w.places[p].inflow += delta;
                w.stats.entry("trade+collect").or_default().0 += 1;
            }
            // request_claim
            16..=37 => {
                let use_real = w.rng.gen_bool(0.85);
                let signer = if use_real || w.old_attestors.is_empty() && w.rng.gen_bool(0.5) {
                    w.attestor()
                } else if !w.old_attestors.is_empty() && w.rng.gen_bool(0.5) {
                    let i = w.rng.gen_range(0..w.old_attestors.len());
                    w.old_attestors[i].insecure_clone()
                } else {
                    Keypair::new()
                };
                let new_owner = match w.rng.gen_range(0..20) {
                    0 => w.attestor(),
                    1 => w.governance(),
                    2 => w.guardian(),
                    _ => w.person(),
                };
                let pl = &w.places[p];
                let nonce = if w.rng.gen_bool(0.8) { pl.nonce + 1 } else { w.rng.gen_range(0..pl.nonce + 3) };
                let now = w.env.now();
                let want = if signer.pubkey() != w.env.attestor.pubkey() {
                    Expect::Err(e::ATTESTOR_MISMATCH)
                } else if pl.pending.is_some() {
                    Expect::Err(e::CLAIM_ALREADY_PENDING)
                } else if nonce != pl.nonce + 1 {
                    Expect::Err(e::BAD_NONCE)
                } else if [w.env.attestor.pubkey(), w.env.governance.pubkey(), w.env.guardian.pubkey()].contains(&new_owner.pubkey()) {
                    Expect::Err(e::INVALID_OWNER)
                } else if pl.owner == Some(new_owner.pubkey()) {
                    Expect::Err(e::SAME_OWNER)
                } else {
                    Expect::Ok
                };
                let ok_ = want == Expect::Ok;
                let ix = sv::request_claim(signer.pubkey(), new_owner.pubkey(), &pl.ph.clone(), nonce);
                w.exec("request_claim", p, &[ix], &[&signer, &new_owner], want);
                if ok_ {
                    let in_probation = now < w.probation_until;
                    let unlock = if in_probation { w.probation_until } else { now } + window;
                    let pl = &mut w.places[p];
                    pl.pending = Some((new_owner.pubkey(), unlock, in_probation));
                    pl.nonce = nonce;
                }
            }
            // cancel_claim by a random role (guardian, governance, attestor, claimant, owner, stranger)
            38..=47 => {
                let pl = &w.places[p];
                let find = |k: Option<Address>| k.and_then(|k| w.people.iter().find(|q| q.pubkey() == k)).map(|k| k.insecure_clone());
                let signer = match w.rng.gen_range(0..6) {
                    0 => w.guardian(),
                    1 => w.governance(),
                    2 => w.attestor(),
                    3 => find(pl.pending.map(|x| x.0)).unwrap_or_else(Keypair::new),
                    4 => find(pl.owner).unwrap_or_else(Keypair::new),
                    _ => Keypair::new(),
                };
                let k = signer.pubkey();
                let now = w.env.now();
                let by_gov = k == w.env.governance.pubkey();
                let want = match pl.pending {
                    None => Expect::Err(e::NO_PENDING_CLAIM),
                    Some((_, unlock, _)) if now >= unlock => Expect::Err(e::CLAIM_WINDOW_ELAPSED),
                    Some((claimant, _, in_probation)) => {
                        if k == w.env.guardian.pubkey() {
                            Expect::Ok
                        } else if by_gov {
                            if pl.governance_cancels >= sv::MAX_GOVERNANCE_SOLO_CANCELS {
                                Expect::Err(e::GOVERNANCE_CANCEL_LIMIT)
                            } else {
                                Expect::Ok
                            }
                        } else if k == claimant || (in_probation && pl.owner == Some(k)) {
                            Expect::Ok
                        } else {
                            Expect::Err(e::UNAUTHORIZED)
                        }
                    }
                };
                let ok_ = want == Expect::Ok;
                let ix = sv::cancel_claim(k, &pl.ph.clone());
                w.exec("cancel_claim", p, &[ix], &[&signer], want);
                if ok_ {
                    let pl = &mut w.places[p];
                    pl.pending = None;
                    pl.governance_cancels += by_gov as u8;
                }
            }
            // finalize_claim
            48..=57 => {
                let pl = &w.places[p];
                let now = w.env.now();
                let want = match pl.pending {
                    None => Expect::Err(e::NO_PENDING_CLAIM),
                    Some((_, unlock, _)) if now < unlock => Expect::Err(e::CLAIM_WINDOW_ACTIVE),
                    Some(_) => Expect::Ok,
                };
                let ok_ = want == Expect::Ok;
                let ix = sv::finalize_claim(&pl.ph.clone());
                w.exec("finalize_claim", p, &[ix], &[], want);
                if ok_ {
                    let pl = &mut w.places[p];
                    pl.owner = pl.pending.take().map(|x| x.0);
                }
            }
            // withdraw by a random signer
            58..=71 => {
                let signer = match w.rng.gen_range(0..7) {
                    0 => w.attestor(),
                    1 => w.governance(),
                    2 => w.env.deployer.insecure_clone(),
                    3 => w.guardian(),
                    _ => w.person(),
                };
                let pl = &w.places[p];
                let a = w.env.lamports(&pl.vault) - w.rent0;
                let b = w.env.lamports(&pl.state) - w.rent_s;
                let want = match pl.owner {
                    None => Expect::Err(e::NO_OWNER),
                    Some(o) if o != signer.pubkey() => Expect::Err(e::NOT_OWNER),
                    Some(_) if a + b == 0 => Expect::Err(e::NOTHING_TO_WITHDRAW),
                    Some(_) => Expect::Ok,
                };
                let ok_ = want == Expect::Ok;
                let ph = pl.ph;
                let before = w.env.lamports(&signer.pubkey());
                let ix = sv::withdraw(signer.pubkey(), &ph);
                w.exec("withdraw", p, &[ix], &[&signer], want);
                if ok_ {
                    // I1/I2: exactly a + b went to the owner (the cranker paid the fee).
                    assert_eq!(w.env.lamports(&signer.pubkey()) - before, a + b);
                    w.places[p].withdrawn += a + b;
                }
            }
            // WSOL pushed into a vault token account, then unwrapped (inflow = all lamports of the account).
            72..=75 => {
                let vault = w.places[p].vault;
                let amount = w.rng.gen_range(1..LAMPORTS_PER_SOL);
                let funder = w.env.funded(3);
                let ata = wsol_ata(&vault);
                ok(w.env.send(
                    &[create_ata_idempotent(funder.pubkey(), vault, NATIVE_MINT, SPL_TOKEN), system_transfer(funder.pubkey(), ata, amount)],
                    &funder,
                    &[],
                ));
                let total = w.env.lamports(&ata);
                let ph = w.places[p].ph;
                w.exec("unwrap_wsol", p, &[sv::unwrap_wsol(&ph, ata)], &[], Expect::Ok);
                w.places[p].inflow += total;
            }
            // Clock warps, sometimes exactly to a pending unlock boundary.
            76..=87 => {
                let pending: Vec<i64> = w.places.iter().filter_map(|x| x.pending.map(|y| y.1)).collect();
                // Probation ends are interesting boundaries too.
                if w.probation_until > w.env.now() && w.rng.gen_bool(0.1) {
                    let t = w.probation_until + w.rng.gen_range(-1..=1);
                    w.env.set_time(t.max(w.env.now() + 1));
                } else if !pending.is_empty() && w.rng.gen_bool(0.3) {
                    let t = pending[w.rng.gen_range(0..pending.len())] + w.rng.gen_range(-1..=1);
                    if t > w.env.now() {
                        w.env.set_time(t);
                    }
                } else {
                    let dt = w.rng.gen_range(1..window * 2 / 3);
                    w.env.warp(dt);
                }
                w.stats.entry("warp").or_default().0 += 1;
            }
            // Admin: pause / unpause (the attestor has no admin power), attestor rotation with the guardian's consent
            // (starts a probation).
            88..=95 => {
                if op < 93 {
                    let k = match w.rng.gen_range(0..3) {
                        0 => w.attestor(),
                        1 => w.governance(),
                        _ => w.guardian(),
                    };
                    let v = w.rng.gen_bool(0.5) as u8;
                    let allowed = k.pubkey() != w.env.attestor.pubkey();
                    w.exec("set_paused", p, &[sv::set_paused(k.pubkey(), v)], &[&k], if allowed { Expect::Ok } else { Expect::Err(e::UNAUTHORIZED) });
                    if allowed {
                        w.paused = v == 1;
                    }
                } else {
                    let gov = w.governance();
                    let grd = w.guardian();
                    let old = w.attestor();
                    let new = Keypair::new();
                    let now = w.env.now();
                    w.exec(
                        "rotate_attestor",
                        p,
                        &[sv::propose_attestor(gov.pubkey(), new.pubkey()), sv::accept_attestor(grd.pubkey())],
                        &[&gov, &grd],
                        Expect::Ok,
                    );
                    w.probation_until = w.probation_until.max(now + sv::PROBATION);
                    w.old_attestors.push(old);
                    w.env.attestor = new;
                }
            }
            // I6: a launch on a fresh place fails only because of the pause.
            _ => {
                let launcher = w.env.funded(2);
                let mint = Keypair::new();
                let place = format!("inv-extra-{step}");
                let r = w.env.try_launch(&place, &launcher, &mint, 0);
                if w.paused {
                    expect_custom_at(&r, 2, e::LAUNCHES_PAUSED);
                    assert!(w.env.account(&mint.pubkey()).is_none());
                } else {
                    ok(r);
                }
                w.stats.entry("launch").or_default().0 += 1;
            }
        }
        w.check(step);
    }
    let total_in: u64 = w.places.iter().map(|p| p.inflow).sum();
    let total_out: u64 = w.places.iter().map(|p| p.withdrawn).sum();
    println!("INV-01: {STEPS} steps, seed {SEED:#x}; inflow {total_in} lamports, withdrawn {total_out}");
    for (k, (okc, errc)) in &w.stats {
        println!("  {k:<16} ok {okc:>4}  refused {errc:>4}");
    }
    assert!(w.stats.get("withdraw").map(|x| x.0).unwrap_or(0) > 0, "walk exercised successful withdraws");
    assert!(w.stats.get("finalize_claim").map(|x| x.0).unwrap_or(0) > 0, "walk exercised finalizations");
}
