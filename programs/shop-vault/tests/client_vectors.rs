//! Cross-language check: every instruction in client/test/vectors.json (built by the TS client) must equal the
//! independent Rust encoding of SPEC §5, and the TS-built instructions must run against the real program.
#![allow(clippy::result_large_err, deprecated)]
mod common;

use common::*;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

struct Vectors(serde_json::Value);

impl Vectors {
    fn load() -> Self {
        let p = manifest_dir().join("client/test/vectors.json");
        Self(serde_json::from_slice(&std::fs::read(&p).expect("client/test/vectors.json")).unwrap())
    }
    fn key(&self, who: &str) -> Address {
        self.0["keys"][who].as_str().unwrap().parse().unwrap()
    }
    fn kp(&self, who: &str) -> Keypair {
        let seed = self.0["seeds"][who].as_u64().unwrap() as u8;
        let k = Keypair::new_from_array([seed; 32]);
        assert_eq!(k.pubkey(), self.key(who), "Keypair.fromSeed == Keypair::new_from_array for {who}");
        k
    }
    fn ix(&self, name: &str) -> Instruction {
        let v = self.0["instructions"].as_array().unwrap().iter().find(|i| i["name"] == name).unwrap_or_else(|| panic!("{name}"));
        Instruction {
            program_id: v["programId"].as_str().unwrap().parse().unwrap(),
            accounts: v["keys"]
                .as_array()
                .unwrap()
                .iter()
                .map(|k| AccountMeta {
                    pubkey: k["pubkey"].as_str().unwrap().parse().unwrap(),
                    is_signer: k["isSigner"].as_bool().unwrap(),
                    is_writable: k["isWritable"].as_bool().unwrap(),
                })
                .collect(),
            data: hex(v["dataHex"].as_str().unwrap()),
        }
    }
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

#[test]
fn vectors_equal_rust_encoding() {
    let v = Vectors::load();
    assert_eq!(v.0["programId"].as_str().unwrap(), PROGRAM_ID.to_string());
    let ph = place_hash(v.0["placeId"].as_str().unwrap());
    assert_eq!(hex(v.0["placeHashHex"].as_str().unwrap()), ph.to_vec());
    let pda = |n: &str| v.0["pdas"][n][0].as_str().unwrap().parse::<Address>().unwrap();
    let bump = |n: &str| v.0["pdas"][n][1].as_u64().unwrap() as u8;
    assert_eq!((pda("config"), bump("config")), sv::config_pda());
    assert_eq!((pda("vault"), bump("vault")), sv::vault_pda(&ph));
    assert_eq!((pda("vaultState"), bump("vaultState")), sv::state_pda(&ph));
    assert_eq!(v.0["pdas"]["programData"].as_str().unwrap().parse::<Address>().unwrap(), sv::programdata_pda());
    let k = |n: &str| v.key(n);
    let expected: Vec<(&str, Instruction)> = vec![
        ("initializeConfig", sv::initialize_config(k("deployer"), k("attestor"), k("governance"), k("guardian"), WINDOW_72H)),
        ("registerLaunch", sv::register_launch(k("launcher"), k("attestor"), &ph, k("mint"))),
        ("requestClaim1", sv::request_claim(k("attestor"), k("owner"), &ph, 1)),
        ("cancelClaimByClaimant", sv::cancel_claim(k("owner"), &ph)),
        ("requestClaim2", sv::request_claim(k("attestor"), k("owner"), &ph, 2)),
        ("finalizeClaim", sv::finalize_claim(&ph)),
        ("withdraw", sv::withdraw(k("owner"), &ph)),
        ("unwrapWsol", sv::unwrap_wsol(&ph, wsol_ata(&sv::vault_pda(&ph).0))),
        ("cancelClaimByGuardian", sv::cancel_claim(k("guardian"), &ph)),
        ("setPausedTrue", sv::set_paused(k("governance"), 1)),
        ("setPausedFalse", sv::set_paused(k("guardian"), 0)),
        ("proposeAttestor", sv::propose_attestor(k("governance"), k("newAttestor"))),
        ("acceptAttestor", sv::accept_attestor(k("guardian"))),
        ("cancelAttestorProposal", sv::cancel_attestor_proposal(k("governance"))),
        ("proposeGuardian", sv::propose_guardian(k("governance"), k("newGuardian"))),
        ("acceptGuardian", sv::accept_guardian(k("guardian"))),
        ("cancelGuardianProposal", sv::cancel_guardian_proposal(k("governance"))),
        ("proposeGovernance", sv::propose_governance(k("governance"), k("newGovernance"))),
        ("withdrawGovernanceProposal", sv::propose_governance(k("governance"), Address::default())),
        ("acceptGovernance", sv::accept_governance(k("newGovernance"))),
    ];
    assert_eq!(expected.len(), v.0["instructions"].as_array().unwrap().len());
    for (name, want) in expected {
        assert_eq!(v.ix(name), want, "{name}");
    }
}

/// The TS-built instructions, run in order against the real program and real pump.
#[test]
fn vectors_execute_against_the_program() {
    let v = Vectors::load();
    let mut env = Env::new();
    env.set_deployer(v.kp("deployer"));
    env.attestor = v.kp("attestor");
    env.governance = v.kp("governance");
    env.guardian = v.kp("guardian");
    let (dep, att, gov) = (env.deployer.insecure_clone(), env.attestor.insecure_clone(), env.governance.insecure_clone());
    let grd = env.guardian.insecure_clone();
    let launcher = v.kp("launcher");
    let mint = v.kp("mint");
    let owner = v.kp("owner");
    env.fund(&launcher.pubkey(), 10 * LAMPORTS_PER_SOL);
    let cranker = env.cranker.insecure_clone();
    let ph = place_hash(v.0["placeId"].as_str().unwrap());
    let vault = sv::vault_pda(&ph).0;

    ok(env.send(&[v.ix("initializeConfig")], &dep, &[]));
    // Launch: Rust-built pump ixs around the TS-built register_launch.
    let ixs = vec![
        cu_limit(600_000),
        create_v2(mint.pubkey(), launcher.pubkey(), &CreateArgs::sol(vault)),
        v.ix("registerLaunch"),
        create_ata_idempotent(launcher.pubkey(), launcher.pubkey(), mint.pubkey(), TOKEN_2022),
        buy_exact_quote_in_v3(launcher.pubkey(), mint.pubkey(), 50_000_000, 1),
    ];
    ok(env.send(&ixs, &launcher, &[&mint, &att]));
    assert_eq!(env.state(&ph).mint, mint.pubkey());

    ok(env.send(&[v.ix("requestClaim1")], &cranker, &[&att, &owner]));
    ok(env.send(&[v.ix("cancelClaimByClaimant")], &cranker, &[&owner]));
    ok(env.send(&[v.ix("requestClaim2")], &cranker, &[&att, &owner]));
    let m = ok(env.send(&[v.ix("cancelClaimByGuardian")], &cranker, &[&grd]));
    assert_eq!(program_events(&m, "ClaimCancelled")[0][3], vec![role::GUARDIAN]);
    let mut rc3 = v.ix("requestClaim2");
    rc3.data[1] = 3;
    ok(env.send(&[rc3], &cranker, &[&att, &owner]));
    let unlock = env.state(&ph).unlock_ts;
    env.set_time(unlock);
    ok(env.send(&[v.ix("finalizeClaim")], &cranker, &[]));
    assert_eq!(env.state(&ph).owner, owner.pubkey());

    env.sweep_and_collect(&mint.pubkey(), &vault);
    let wsol = wsol_ata(&vault);
    let funder = env.funded(3);
    ok(env.send(
        &[create_ata_idempotent(funder.pubkey(), vault, NATIVE_MINT, SPL_TOKEN), system_transfer(funder.pubkey(), wsol, LAMPORTS_PER_SOL)],
        &funder,
        &[],
    ));
    ok(env.send(&[v.ix("unwrapWsol")], &cranker, &[]));
    let before = env.lamports(&owner.pubkey());
    let expect = env.lamports(&vault) - env.rent(0);
    ok(env.send(&[v.ix("withdraw")], &cranker, &[&owner]));
    assert_eq!(env.lamports(&owner.pubkey()) - before, expect);

    ok(env.send(&[v.ix("setPausedTrue")], &cranker, &[&gov]));
    ok(env.send(&[v.ix("setPausedFalse")], &cranker, &[&grd]));
    ok(env.send(&[v.ix("proposeAttestor")], &cranker, &[&gov]));
    ok(env.send(&[v.ix("cancelAttestorProposal")], &cranker, &[&gov]));
    ok(env.send(&[v.ix("proposeAttestor"), v.ix("acceptAttestor")], &cranker, &[&gov, &grd]));
    assert_eq!(env.config().attestor, v.key("newAttestor"));
    ok(env.send(&[v.ix("proposeGuardian")], &cranker, &[&gov]));
    ok(env.send(&[v.ix("cancelGuardianProposal")], &cranker, &[&gov]));
    ok(env.send(&[v.ix("proposeGuardian"), v.ix("acceptGuardian")], &cranker, &[&gov, &grd]));
    assert_eq!(env.config().guardian, v.key("newGuardian"));
    let new_gov = v.kp("newGovernance");
    ok(env.send(&[v.ix("proposeGovernance")], &cranker, &[&gov]));
    ok(env.send(&[v.ix("withdrawGovernanceProposal")], &cranker, &[&gov]));
    assert_eq!(env.config().pending_governance, Address::default());
    ok(env.send(&[v.ix("proposeGovernance")], &cranker, &[&gov]));
    ok(env.send(&[v.ix("acceptGovernance")], &cranker, &[&new_gov]));
    assert_eq!(env.config().governance, new_gov.pubkey());
}
