import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import * as sv from "../src/index.ts";

function put64(d: Uint8Array, o: number, v: bigint, signed = false) {
  const dv = new DataView(d.buffer);
  if (signed) dv.setBigInt64(o, v, true);
  else dv.setBigUint64(o, v, true);
}

test("decodeConfig reads SPEC §3.2 offsets", () => {
  const d = new Uint8Array(256);
  const [att, gov, pa, grd, pg, pgov] = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
  d[0] = 1;
  d[1] = 1;
  d[2] = 254;
  d[3] = 1;
  d[4] = 1;
  d[5] = sv.ConfigFlag.AttestorVetoed | sv.ConfigFlag.GovernanceByGuardian;
  d.set(att.toBytes(), 8);
  d.set(pa.toBytes(), 40);
  put64(d, 72, 1_791_000_000n, true);
  d.set(grd.toBytes(), 80);
  d.set(pg.toBytes(), 112);
  put64(d, 144, 1_791_000_001n, true);
  d.set(gov.toBytes(), 152);
  d.set(pgov.toBytes(), 184);
  put64(d, 216, 1_791_000_002n, true);
  put64(d, 224, 259_200n, true);
  put64(d, 232, 1_791_604_800n, true);
  put64(d, 240, 604_800n, true);
  const c = sv.decodeConfig(d);
  assert.equal(c.bump, 254);
  assert.equal(c.paused, true);
  assert.equal(c.flavor, "devnet");
  assert.ok(c.attestorProposalEscalated && !c.guardianProposalEscalated && c.pendingGovernanceByGuardian);
  assert.ok(c.attestor.equals(att) && c.governance.equals(gov) && c.guardian.equals(grd));
  assert.ok(c.pendingAttestor?.equals(pa) && c.pendingGuardian?.equals(pg) && c.pendingGovernance?.equals(pgov));
  assert.deepEqual([c.pendingAttestorEta, c.pendingGuardianEta, c.pendingGovernanceEta], [1_791_000_000n, 1_791_000_001n, 1_791_000_002n]);
  assert.equal(c.claimWindowSecs, 259_200n);
  assert.equal(c.probationUntil, 1_791_604_800n);
  assert.equal(c.rotationDelaySecs, 604_800n);
  d.fill(0, 184, 216);
  assert.equal(sv.decodeConfig(d).pendingGovernance, null);
  assert.throws(() => sv.decodeConfig(d.subarray(0, 255)));
  const bad = d.slice();
  bad[0] = 2;
  assert.throws(() => sv.decodeConfig(bad));
});

test("decodeVaultState reads SPEC §3.3 offsets", () => {
  const d = new Uint8Array(208);
  const ph = sv.placeHash("p");
  const mint = Keypair.generate().publicKey, launcher = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey, pending = Keypair.generate().publicKey;
  d[0] = 2;
  d[1] = 1;
  d[2] = 255;
  d[3] = 253;
  d[4] = 1;
  d[5] = 1;
  d[6] = 2;
  d[7] = 1;
  d.set(ph, 8);
  d.set(mint.toBytes(), 40);
  d.set(launcher.toBytes(), 72);
  d.set(owner.toBytes(), 104);
  d.set(pending.toBytes(), 136);
  put64(d, 168, 1_791_259_200n, true);
  put64(d, 176, 3n);
  put64(d, 184, 123_456_789n);
  put64(d, 192, 1_791_000_000n, true);
  put64(d, 200, 1_791_100_000n, true);
  const s = sv.decodeVaultState(d);
  assert.equal(s.stateBump, 255);
  assert.equal(s.vaultBump, 253);
  assert.deepEqual(s.placeHash, ph);
  assert.ok(s.mint.equals(mint) && s.launcher.equals(launcher));
  assert.ok(s.owner?.equals(owner));
  assert.ok(s.pending?.owner.equals(pending));
  assert.equal(s.pending?.unlockTs, 1_791_259_200n);
  assert.equal(s.pending?.inProbation, true);
  assert.equal(s.governanceCancels, 2);
  assert.equal(s.claimNonce, 3n);
  assert.equal(s.totalWithdrawn, 123_456_789n);
  assert.equal(s.createdAt, 1_791_000_000n);
  assert.equal(s.ownerSince, 1_791_100_000n);
  d[4] = 0;
  d[5] = 0;
  const s2 = sv.decodeVaultState(d);
  assert.equal(s2.owner, null);
  assert.equal(s2.pending, null);
  assert.throws(() => sv.decodeVaultState(new Uint8Array(207)));
});

test("decodeBondingCurvePrefix reads the bytes register_launch checks", () => {
  const d = new Uint8Array(166);
  d.set(sv.BONDING_CURVE_DISCRIMINATOR, 0);
  put64(d, 32, 5n);
  d[48] = 1;
  const creator = Keypair.generate().publicKey;
  d.set(creator.toBytes(), 49);
  d[81] = 1;
  d[82] = 0;
  d.set(sv.NATIVE_MINT.toBytes(), 83);
  d[124] = 1;
  put64(d, 125, 777n);
  const c = sv.decodeBondingCurvePrefix(d);
  assert.equal(c.realQuoteReserves, 5n);
  assert.ok(c.complete && c.isMayhemMode && !c.isCashbackCoin && c.isHolderReward);
  assert.ok(c.creator.equals(creator));
  assert.ok(c.quoteMint.equals(sv.NATIVE_MINT));
  assert.equal(c.creatorFeeBucket, 777n);
  d[0] = 0;
  assert.throws(() => sv.decodeBondingCurvePrefix(d));
});

test("feesWaiting sums withdrawable and collectable", () => {
  const r = sv.feesWaiting({
    vaultLamports: 650_240n + 1_000n,
    vaultStateLamports: 1_706_880n + 5n,
    rentMin0: 650_240n,
    rentMinVaultState: 1_706_880n,
    pumpCreatorVaultLamports: 650_240n + 20n,
    curveCreatorFeeBucket: 300n,
    wsolLamports: 2_039_280n,
  });
  assert.deepEqual(r, { withdrawableNow: 1_005n, collectable: 20n + 300n + 2_039_280n, total: 1_005n + 2_039_600n });
  assert.equal(sv.feesWaiting({ vaultLamports: 0n, vaultStateLamports: 0n, rentMin0: 1n, rentMinVaultState: 1n }).total, 0n);
});
