import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Keypair, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import * as sv from "../src/index.ts";

const k = () => Keypair.generate().publicKey;
const ph = sv.placeHash("ChIJN1t_tDeuEmsRUsoyG83frY4");
const [config] = sv.configPda();
const [vault] = sv.vaultPda(ph);
const [state] = sv.vaultStatePda(ph);

type Flag = "s" | "w" | "sw" | "";
function metas(ix: TransactionInstruction): [string, Flag][] {
  return ix.keys.map((m) => [m.pubkey.toBase58(), ((m.isSigner ? "s" : "") + (m.isWritable ? "w" : "")) as Flag]);
}
const m = (p: PublicKey, f: Flag): [string, Flag] => [p.toBase58(), f];

test("initialize_config: 105 bytes, accounts per §5.0", () => {
  const payer = k(), att = k(), gov = k(), grd = k();
  const ix = sv.initializeConfig({ payer, attestor: att, governance: gov, guardian: grd, claimWindowSecs: 259_200 });
  assert.ok(ix.programId.equals(sv.SHOP_VAULT_PROGRAM_ID));
  assert.equal(ix.data.length, 105);
  assert.equal(ix.data[0], 0);
  assert.deepEqual(Uint8Array.from(ix.data.subarray(1, 33)), att.toBytes());
  assert.deepEqual(Uint8Array.from(ix.data.subarray(33, 65)), gov.toBytes());
  assert.deepEqual(Uint8Array.from(ix.data.subarray(65, 97)), grd.toBytes());
  assert.equal(ix.data.readBigInt64LE(97), 259_200n);
  assert.deepEqual(metas(ix), [m(payer, "sw"), m(config, "w"), m(sv.programDataPda(), ""), m(sv.SYSTEM_PROGRAM_ID, "")]);
});

test("register_launch: [1] place_hash, 9 accounts per §5.2", () => {
  const launcher = k(), att = k(), mint = k();
  const ix = sv.registerLaunch({ launcher, attestor: att, placeHash: ph, mint });
  assert.equal(ix.data.length, 33);
  assert.equal(ix.data[0], 1);
  assert.deepEqual(Uint8Array.from(ix.data.subarray(1)), ph);
  assert.deepEqual(metas(ix), [
    m(launcher, "sw"),
    m(att, "s"),
    m(config, ""),
    m(state, "w"),
    m(vault, "w"),
    m(mint, ""),
    m(sv.bondingCurvePda(mint), ""),
    m(sv.SYSTEM_PROGRAM_ID, ""),
    m(sv.INSTRUCTIONS_SYSVAR_ID, ""),
  ]);
  assert.throws(() => sv.registerLaunch({ launcher, attestor: att, placeHash: ph.subarray(1), mint }));
});

test("claims: request [2] nonce u64 / cancel [3] / finalize [4]", () => {
  const att = k(), owner = k();
  const r = sv.requestClaim({ attestor: att, newOwner: owner, placeHash: ph, nonce: 0xffff_ffff_ffff_fffen });
  assert.equal(r.data.length, 9);
  assert.equal(r.data[0], 2);
  assert.equal(r.data.readBigUInt64LE(1), 0xffff_ffff_ffff_fffen);
  assert.deepEqual(metas(r), [m(att, "s"), m(owner, "s"), m(config, ""), m(state, "w"), m(sv.INSTRUCTIONS_SYSVAR_ID, "")]);
  assert.throws(() => sv.requestClaim({ attestor: att, newOwner: owner, placeHash: ph, nonce: -1 }));
  assert.throws(() => sv.requestClaim({ attestor: att, newOwner: owner, placeHash: ph, nonce: 2n ** 64n }));
  const c = sv.cancelClaim({ authority: owner, placeHash: ph });
  assert.deepEqual([...c.data], [3]);
  assert.deepEqual(metas(c), [m(owner, "s"), m(config, ""), m(state, "w")]);
  const f = sv.finalizeClaim({ placeHash: ph });
  assert.deepEqual([...f.data], [4]);
  assert.deepEqual(metas(f), [m(state, "w")]);
});

test("withdraw [5] and unwrap_wsol [6]", () => {
  const owner = k();
  const w = sv.withdraw({ owner, placeHash: ph });
  assert.deepEqual([...w.data], [5]);
  assert.deepEqual(metas(w), [m(owner, "sw"), m(state, "w"), m(vault, "w"), m(sv.SYSTEM_PROGRAM_ID, "")]);
  const wsol = sv.vaultWsolAta(vault);
  const u = sv.unwrapWsol({ placeHash: ph, wsolAccount: wsol });
  assert.deepEqual([...u.data], [6]);
  assert.deepEqual(metas(u), [m(state, ""), m(vault, "w"), m(wsol, "w"), m(sv.SPL_TOKEN_PROGRAM_ID, "")]);
});

test("admin [7..15]: data and [authority (S), config (W)]", () => {
  const a = k(), n = k();
  const cases: [TransactionInstruction, number[]][] = [
    [sv.setPaused({ authority: a, paused: true }), [7, 1]],
    [sv.setPaused({ authority: a, paused: false }), [7, 0]],
    [sv.proposeAttestor({ governance: a, newAttestor: n }), [8, ...n.toBytes()]],
    [sv.acceptAttestor({ caller: a }), [9]],
    [sv.cancelAttestorProposal({ authority: a }), [10]],
    [sv.proposeGovernance({ governance: a, newGovernance: n }), [11, ...n.toBytes()]],
    [sv.proposeGovernance({ authority: a, newGovernance: n }), [11, ...n.toBytes()]],
    [sv.withdrawGovernanceProposal({ authority: a }), [11, ...new Uint8Array(32)]],
    [sv.acceptGovernance({ newGovernance: a }), [12]],
    [sv.proposeGuardian({ governance: a, newGuardian: n }), [13, ...n.toBytes()]],
    [sv.acceptGuardian({ caller: a }), [14]],
    [sv.cancelGuardianProposal({ authority: a }), [15]],
  ];
  for (const [ix, data] of cases) {
    assert.deepEqual([...ix.data], data);
    assert.deepEqual(metas(ix), [m(a, "s"), m(config, "w")]);
  }
});

test("Ix discriminators are 0..15 and unique", () => {
  const v = Object.values(sv.Ix);
  assert.deepEqual(v, [...Array(16).keys()]);
  assert.throws(() => sv.proposeGovernance({ newGovernance: k() }));
});

test("error codes 100..139 and parseShopVaultError", () => {
  const codes = Object.values(sv.ShopVaultError);
  assert.deepEqual(codes, Array.from({ length: 40 }, (_, i) => 100 + i));
  assert.equal(sv.ShopVaultError.AttestorScope, 136);
  assert.equal(sv.ShopVaultError.GovernanceCancelLimit, 137);
  assert.equal(sv.ShopVaultError.AlreadyRegistered, 110);
  assert.equal(sv.ShopVaultError.NotOwner, 126);
  assert.deepEqual(sv.parseShopVaultError({ InstructionError: [2, { Custom: 110 }] }), { index: 2, code: 110, name: "AlreadyRegistered" });
  assert.deepEqual(sv.parseShopVaultError({ InstructionError: [0, { Custom: 1 }] }), { index: 0, code: 1, name: undefined });
  assert.equal(sv.parseShopVaultError({ InstructionError: [0, "MissingRequiredSignature"] }), undefined);
  assert.equal(sv.parseShopVaultError("BlockhashNotFound"), undefined);
});

test("build constants: a devnet binary cannot take the mainnet window", () => {
  assert.ok(sv.BuildConstants.devnet.maxClaimWindowSecs < sv.BuildConstants.mainnet.minClaimWindowSecs);
  assert.equal(sv.BuildConstants.mainnet.escalatedRotationDelaySecs, 2 * sv.BuildConstants.mainnet.rotationDelaySecs);
});

test("u64/i64 encoders", () => {
  assert.deepEqual([...sv.u64le(1n)], [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...sv.i64le(-1)], [255, 255, 255, 255, 255, 255, 255, 255]);
  assert.throws(() => sv.i64le(2n ** 63n));
});
