import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as sv from "../src/index.ts";
import V from "./vectors.json" with { type: "json" };

test("place hash: SPEC §3.1 test vector", () => {
  assert.equal(sv.placeHashHex("ChIJN1t_tDeuEmsRUsoyG83frY4"), "52791f4bf8f035bc928405e161a4c28a262db717cfe91ae8d3615563066afa15");
  assert.equal(sv.placeHash("ChIJN1t_tDeuEmsRUsoyG83frY4").length, 32);
});

test("place hash: no normalisation, rejects places/ prefix and empty ids", () => {
  assert.notEqual(sv.placeHashHex("abc"), sv.placeHashHex("abc "));
  assert.notEqual(sv.placeHashHex("abc"), sv.placeHashHex("ABC"));
  assert.throws(() => sv.placeHash("places/ChIJN1t_tDeuEmsRUsoyG83frY4"));
  assert.throws(() => sv.placeHash(""));
  // UTF-8 bytes (cross-checked with node:crypto, an independent sha256).
  for (const id of ["é", "ChIJ-Zürich_☕", "a".repeat(300)]) {
    assert.equal(sv.placeHashHex(id), createHash("sha256").update(Buffer.from(id, "utf8")).digest("hex"));
  }
});

test("hex helpers round-trip", () => {
  const b = Uint8Array.from([0, 1, 254, 255, 16]);
  assert.deepEqual(sv.fromHex(sv.toHex(b)), b);
  assert.throws(() => sv.fromHex("abc"));
});

test("PDAs match the committed cross-language vectors", () => {
  const ph = sv.placeHash(V.placeId);
  assert.deepEqual(sv.configPda().map(String), V.pdas.config.map(String));
  assert.deepEqual(sv.vaultPda(ph).map(String), V.pdas.vault.map(String));
  assert.deepEqual(sv.vaultStatePda(ph).map(String), V.pdas.vaultState.map(String));
  assert.equal(sv.programDataPda().toBase58(), V.pdas.programData);
  assert.equal(sv.bondingCurvePda(new PublicKey(V.keys.mint)).toBase58(), V.pdas.bondingCurve);
  assert.equal(sv.vaultWsolAta(sv.vaultPda(ph)[0]).toBase58(), V.pdas.vaultWsolAta);
});

test("PDAs are re-derivable with createProgramAddressSync from their bumps and are off-curve", () => {
  const ph = sv.placeHash("some place");
  const [vault, vb] = sv.vaultPda(ph);
  const [state, sb] = sv.vaultStatePda(ph);
  const enc = new TextEncoder();
  assert.ok(PublicKey.createProgramAddressSync([enc.encode("vault"), ph, Uint8Array.of(vb)], sv.SHOP_VAULT_PROGRAM_ID).equals(vault));
  assert.ok(PublicKey.createProgramAddressSync([enc.encode("vault_state"), ph, Uint8Array.of(sb)], sv.SHOP_VAULT_PROGRAM_ID).equals(state));
  assert.ok(!PublicKey.isOnCurve(vault.toBytes()));
  assert.ok(!PublicKey.isOnCurve(state.toBytes()));
  assert.ok(!vault.equals(state));
  const a = sv.placeAddresses("some place");
  assert.ok(a.vault.equals(vault) && a.vaultState.equals(state) && a.vaultBump === vb && a.stateBump === sb);
});

test("PDAs honour a custom program id and reject bad hashes", () => {
  const pid = Keypair.generate().publicKey;
  const ph = sv.placeHash("x");
  assert.ok(!sv.vaultPda(ph, pid)[0].equals(sv.vaultPda(ph)[0]));
  assert.throws(() => sv.vaultPda(new Uint8Array(31)));
  assert.throws(() => sv.vaultStatePda(new Uint8Array(33)));
});

test("pump creator vault of our vault (where v2 fees land before collect)", () => {
  const vault = sv.vaultPda(sv.placeHash(V.placeId))[0];
  const expected = PublicKey.findProgramAddressSync([new TextEncoder().encode("creator-vault"), vault.toBytes()], sv.PUMP_PROGRAM_ID)[0];
  assert.ok(sv.pumpCreatorVaultPda(vault).equals(expected));
});
