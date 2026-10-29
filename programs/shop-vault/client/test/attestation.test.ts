import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  type VersionedMessage,
} from "@solana/web3.js";
import BN from "bn.js";
import * as sv from "../src/index.ts";
import V from "./vectors.json" with { type: "json" };

// pump-sdk 3.2.0's ESM build fails under plain Node ESM (a dependency's named import from CJS anchor); use require.
const pump = createRequire(import.meta.url)("@pump-fun/pump-sdk");
const sdk = new pump.PumpSdk();

const PLACE = "ChIJN1t_tDeuEmsRUsoyG83frY4";
const BUYBACK = new PublicKey("5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD");
const BLOCKHASH = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

// ------------------------------------------------------------------------------------------------ Appendix A

test("Appendix A launch message: 153 B, field offsets", () => {
  const ph = sv.placeHash(PLACE);
  const launcher = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
  const m = sv.encodeLaunchAttestation({ cluster: "devnet", placeHash: ph, launcher, mint, expiry: 1_791_421_200n });
  assert.equal(m.length, 153);
  assert.equal(new TextDecoder().decode(m.subarray(0, 16)), "CORNERSHOP:LNCH1");
  assert.deepEqual(m.subarray(16, 48), sv.SHOP_VAULT_PROGRAM_ID.toBytes());
  assert.equal(m[48], 1);
  assert.deepEqual(m.subarray(49, 81), ph);
  assert.deepEqual(m.subarray(81, 113), launcher.toBytes());
  assert.deepEqual(m.subarray(113, 145), mint.toBytes());
  assert.equal(new DataView(m.buffer).getBigInt64(145, true), 1_791_421_200n);
  assert.throws(() => sv.encodeLaunchAttestation({ cluster: "devnet", placeHash: ph.subarray(1), launcher, mint, expiry: 0 }));
});

test("Appendix A claim message: 129 B, field offsets", () => {
  const ph = sv.placeHash(PLACE);
  const owner = Keypair.generate().publicKey;
  const m = sv.encodeClaimAttestation({ cluster: "mainnet", placeHash: ph, newOwner: owner, nonce: 9n, expiry: 42 });
  assert.equal(m.length, 129);
  assert.equal(new TextDecoder().decode(m.subarray(0, 16)), "CORNERSHOP:CLAM1");
  assert.equal(m[48], 0);
  assert.deepEqual(m.subarray(81, 113), owner.toBytes());
  const dv = new DataView(m.buffer);
  assert.equal(dv.getBigUint64(113, true), 9n);
  assert.equal(dv.getBigInt64(121, true), 42n);
});

test("Appendix A ed25519 instruction layout (offsets 16/48/112, indexes 0xFFFF)", () => {
  const att = Keypair.generate().publicKey;
  const msg = new Uint8Array(153).fill(7);
  const sig = new Uint8Array(64).fill(9);
  const ix = sv.ed25519AttestationInstruction({ attestor: att, signature: sig, message: msg });
  assert.ok(ix.programId.equals(sv.ED25519_PROGRAM_ID));
  assert.equal(ix.keys.length, 0);
  const d = ix.data;
  assert.equal(d.length, 112 + 153);
  assert.deepEqual([d[0], d[1]], [1, 0]);
  assert.deepEqual([2, 4, 6, 8, 10, 12, 14].map((o) => d.readUInt16LE(o)), [48, 0xffff, 16, 0xffff, 112, 153, 0xffff]);
  assert.deepEqual(Uint8Array.from(d.subarray(16, 48)), att.toBytes());
  assert.deepEqual(Uint8Array.from(d.subarray(48, 112)), sig);
  assert.deepEqual(Uint8Array.from(d.subarray(112)), msg);
  assert.throws(() => sv.ed25519AttestationInstruction({ attestor: att, signature: sig.subarray(1), message: msg }));
});

test("Appendix A vectors match", () => {
  const v = sv.encodeLaunchAttestation({
    cluster: "devnet",
    placeHash: sv.placeHash(V.placeId),
    launcher: new PublicKey(V.keys.launcher),
    mint: new PublicKey(V.keys.mint),
    expiry: 1_791_421_200,
  });
  assert.equal(sv.toHex(v), V.appendixA.launchMessageHex);
});

// ------------------------------------------------------------------------------------------ §8.4 launch policy

interface LaunchFixture {
  launcher: Keypair;
  mint: Keypair;
  attestor: Keypair;
  alt: AddressLookupTableAccount;
  policy: sv.LaunchPolicy;
  ixs: TransactionInstruction[];
}

async function launchFixture(opts: { devBuy?: bigint; creator?: PublicKey; name?: string; mayhem?: boolean } = {}): Promise<LaunchFixture> {
  const launcher = Keypair.generate(), mint = Keypair.generate(), attestor = Keypair.generate();
  const ph = sv.placeHash(PLACE);
  const [vault] = sv.vaultPda(ph);
  const name = "Corner Cafe Ltd", symbol = "CAFE", uri = "https://cornershop.tiejiucai.workers.dev/m/abcdefghijklmnopqrstuvwxyz0123456789ab";
  const create: TransactionInstruction = await sdk.createV2Instruction({
    mint: mint.publicKey,
    name: opts.name ?? name,
    symbol,
    uri,
    creator: opts.creator ?? vault,
    user: launcher.publicKey,
    mayhemMode: !!opts.mayhem,
  });
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    create,
    sv.registerLaunch({ launcher: launcher.publicKey, attestor: attestor.publicKey, placeHash: ph, mint: mint.publicKey }),
  ];
  const devBuy = opts.devBuy ?? 10_000_000n;
  if (devBuy > 0n) {
    ixs.push(
      new TransactionInstruction({
        programId: sv.ASSOCIATED_TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: launcher.publicKey, isSigner: true, isWritable: true },
          { pubkey: sv.associatedTokenAddress(launcher.publicKey, mint.publicKey, sv.TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
          { pubkey: launcher.publicKey, isSigner: false, isWritable: false },
          { pubkey: mint.publicKey, isSigner: false, isWritable: false },
          { pubkey: sv.SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: sv.TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      }),
      await sdk.getBuyExactQuoteInV3InstructionRaw({
        user: launcher.publicKey,
        mint: mint.publicKey,
        spendableQuoteIn: new BN(devBuy.toString()),
        minTokensOut: new BN(1),
        buybackFeeRecipient: BUYBACK,
      }),
    );
  }
  // The official ALT: keys shared by every launch (SPEC §8.1).
  const shared = [
    pump.GLOBAL_PDA,
    pump.PUMP_EVENT_AUTHORITY_PDA,
    pump.PUMP_FEE_CONFIG_PDA,
    pump.getGlobalParamsPda(),
    pump.getSolVaultPda(),
    new PublicKey("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM"),
    sv.TOKEN_2022_PROGRAM_ID,
    sv.SPL_TOKEN_PROGRAM_ID,
    sv.NATIVE_MINT,
    BUYBACK,
    sv.SYSTEM_PROGRAM_ID,
    sv.configPda()[0],
    pump.MAYHEM_PROGRAM_ID,
    sv.INSTRUCTIONS_SYSVAR_ID,
  ] as PublicKey[];
  const alt = new AddressLookupTableAccount({
    key: new PublicKey("Ckp9Ys8vQZ3kGoqWb5H1sBqv9t8h1o6WgV6q4wN9sYrE"),
    state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: shared },
  });
  return {
    launcher,
    mint,
    attestor,
    alt,
    ixs,
    policy: {
      attestor: attestor.publicKey,
      launcher: launcher.publicKey,
      mint: mint.publicKey,
      placeId: PLACE,
      name,
      symbol,
      uri,
      maxDevBuyLamports: 1_000_000_000n,
      lookupTable: alt,
    },
  };
}

function compile(f: LaunchFixture, ixs = f.ixs, payer = f.launcher.publicKey, alts = [f.alt]): VersionedMessage {
  return new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message(alts);
}

test("launch policy accepts the SDK-built atomic launch tx (with and without a dev buy) and it fits 1,232 B", async () => {
  for (const devBuy of [10_000_000n, 0n]) {
    const f = await launchFixture({ devBuy });
    const msg = compile(f);
    assert.deepEqual(sv.checkLaunchMessage(msg, f.policy), []);
    assert.equal(msg.header.numRequiredSignatures, 3);
    const size = 1 + 3 * 64 + msg.serialize().length;
    assert.ok(size <= 1232, `launch tx ${size} B`);
    // placeHash instead of placeId works too.
    assert.deepEqual(sv.checkLaunchMessage(msg, { ...f.policy, placeId: undefined, placeHash: sv.placeHash(PLACE) }), []);
  }
});

test("launch policy rejects moderated-field, creator and flag changes", async () => {
  const f = await launchFixture({ name: "Not Approved" });
  assert.match(sv.checkLaunchMessage(compile(f), f.policy).join("\n"), /name differs/);
  const g = await launchFixture({ creator: Keypair.generate().publicKey });
  assert.match(sv.checkLaunchMessage(compile(g), g.policy).join("\n"), /creator is not the place vault/);
  const h = await launchFixture({ mayhem: true });
  assert.match(sv.checkLaunchMessage(compile(h), h.policy).join("\n"), /mayhem/);
  const i = await launchFixture();
  assert.match(sv.checkLaunchMessage(compile(i), { ...i.policy, uri: i.policy.uri + "x" }).join("\n"), /uri differs/);
  assert.match(sv.checkLaunchMessage(compile(i), { ...i.policy, placeId: "other-place" }).join("\n"), /place_hash mismatch/);
});

test("launch policy rejects extra instructions, attestor misuse, dev-buy cap, budget caps, ALT and signer problems", async () => {
  const f = await launchFixture();
  const att = f.attestor.publicKey;
  const steal = SystemProgram.transfer({ fromPubkey: f.launcher.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  assert.match(sv.checkLaunchMessage(compile(f, [...f.ixs, steal]), f.policy).join("\n"), /got 5 non-budget/);
  // The attestor referenced by another instruction.
  const touch = SystemProgram.transfer({ fromPubkey: f.launcher.publicKey, toPubkey: att, lamports: 1 });
  const withTouch = [...f.ixs.slice(0, 2), touch, ...f.ixs.slice(2)];
  assert.ok(sv.checkLaunchMessage(compile(f, withTouch), f.policy).length > 0);
  // Attestor as writable signer.
  const regW = new TransactionInstruction({ ...f.ixs[3], keys: f.ixs[3].keys.map((k, j) => (j === 1 ? { ...k, isWritable: true } : k)) });
  assert.match(sv.checkLaunchMessage(compile(f, [...f.ixs.slice(0, 3), regW, ...f.ixs.slice(4)]), f.policy).join("\n"), /read-only signer/);
  // Dev buy over the cap.
  assert.match(sv.checkLaunchMessage(compile(f), { ...f.policy, maxDevBuyLamports: 9_999_999n }).join("\n"), /dev buy 10000000 > cap/);
  // Compute caps.
  assert.match(sv.checkLaunchMessage(compile(f), { ...f.policy, maxComputeUnitLimit: 300_000 }).join("\n"), /compute unit limit/);
  assert.match(sv.checkLaunchMessage(compile(f), { ...f.policy, maxComputeUnitPriceMicroLamports: 1n }).join("\n"), /compute unit price/);
  // Lookup tables: missing or foreign.
  assert.match(sv.checkLaunchMessage(compile(f), { ...f.policy, lookupTable: undefined }).join("\n"), /none was supplied/);
  const foreign = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: f.alt.state });
  assert.match(sv.checkLaunchMessage(compile(f, f.ixs, f.launcher.publicKey, [foreign]), f.policy).join("\n"), /not the official/);
  // A different fee payer / launcher.
  const other = Keypair.generate().publicKey;
  assert.ok(sv.checkLaunchMessage(compile(f, f.ixs, other), f.policy).some((e) => /fee payer|signer/.test(e)));
  // A different mint than reserved.
  assert.match(sv.checkLaunchMessage(compile(f), { ...f.policy, mint: Keypair.generate().publicKey }).join("\n"), /mint/);
  // A different attestor key in register_launch.
  assert.ok(sv.checkLaunchMessage(compile(f), { ...f.policy, attestor: Keypair.generate().publicKey }).length > 0);
  // Order: dev buy before register.
  const reordered = [f.ixs[0], f.ixs[1], f.ixs[2], f.ixs[4], f.ixs[5], f.ixs[3]];
  assert.ok(sv.checkLaunchMessage(compile(f, reordered), f.policy).length > 0);
  // Legacy message.
  const legacy = new TransactionMessage({ payerKey: f.launcher.publicKey, recentBlockhash: BLOCKHASH, instructions: f.ixs }).compileToLegacyMessage();
  assert.deepEqual(sv.checkLaunchMessage(legacy, f.policy), ["message must be v0"]);
});

test("decodeCreateV2Args decodes the SDK's create_v2 and rejects trailing bytes", async () => {
  const f = await launchFixture();
  const a = sv.decodeCreateV2Args(f.ixs[2].data);
  assert.equal(a.name, "Corner Cafe Ltd");
  assert.equal(a.symbol, "CAFE");
  assert.ok(a.creator.equals(sv.vaultPda(sv.placeHash(PLACE))[0]));
  assert.equal(a.isMayhemMode || a.isCashbackEnabled || a.isHolderReward, false);
  assert.equal(a.creatorFeeBps, 0n);
  assert.throws(() => sv.decodeCreateV2Args(Buffer.concat([f.ixs[2].data, Buffer.from([0])])));
  assert.throws(() => sv.decodeCreateV2Args(f.ixs[2].data.subarray(0, 40)));
});

// ------------------------------------------------------------------------------------------- §8.4 claim policy

test("claim policy", () => {
  const attestor = Keypair.generate(), owner = Keypair.generate(), relayer = Keypair.generate();
  const ph = sv.placeHash(PLACE);
  const rc = sv.requestClaim({ attestor: attestor.publicKey, newOwner: owner.publicKey, placeHash: ph, nonce: 3n });
  const cb = ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 });
  const msg = (ixs: TransactionInstruction[], payer = owner.publicKey) =>
    new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message();
  const policy: sv.ClaimPolicy = { attestor: attestor.publicKey, newOwner: owner.publicKey, placeId: PLACE, expectedNonce: 3n };
  assert.deepEqual(sv.checkClaimMessage(msg([cb, rc]), policy), []);
  assert.deepEqual(sv.checkClaimMessage(msg([rc]), policy), []);
  // Relayer as fee payer.
  assert.deepEqual(sv.checkClaimMessage(msg([rc], relayer.publicKey), { ...policy, relayer: relayer.publicKey }), []);
  assert.ok(sv.checkClaimMessage(msg([rc], relayer.publicKey), policy).length > 0, "unknown relayer");
  // Wrong nonce, wrong place, wrong owner.
  assert.match(sv.checkClaimMessage(msg([rc]), { ...policy, expectedNonce: 4n }).join(), /nonce/);
  assert.ok(sv.checkClaimMessage(msg([rc]), { ...policy, placeId: "elsewhere" }).length > 0);
  assert.ok(sv.checkClaimMessage(msg([rc]), { ...policy, newOwner: relayer.publicKey }).length > 0);
  // A request_claim without the Instructions sysvar (old account list).
  const short = new TransactionInstruction({ ...rc, keys: rc.keys.slice(0, 4) });
  assert.match(sv.checkClaimMessage(msg([short]), policy).join(), /4 accounts, expected 5/);
  // Extra instruction, attestor as fee payer, attestor touched elsewhere.
  const steal = SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: relayer.publicKey, lamports: 1 });
  assert.match(sv.checkClaimMessage(msg([rc, steal]), policy).join(), /exactly one/);
  assert.ok(sv.checkClaimMessage(msg([rc], attestor.publicKey), policy).length > 0);
  const touch = SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: attestor.publicKey, lamports: 1 });
  assert.ok(sv.checkClaimMessage(msg([touch, rc]), policy).length > 0);
  // Compute cap.
  assert.match(sv.checkClaimMessage(msg([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), rc]), policy).join(), /compute unit limit/);
});
