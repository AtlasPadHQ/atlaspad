/**
 * SPEC §8.4 attestor policy (worker/policy.ts): exhaustive negative tests + seeded fuzzing, against messages built
 * with the real pump-sdk 3.2.0 / web3.js 1.99 / shop-vault client builders. Differential property: whenever
 * worker/policy.ts accepts a message, the shop-vault client's own checker (the reference gate) accepts it too.
 */
import { describe, expect, it } from 'vitest';
import { b58encode, toHex, u64le } from './bytes';
import { ALT_KEYS, SHOP_VAULT_PROGRAM_ID } from './consts';
import { __clearKeyCache } from './keys';
import { approveClaim, approveLaunch, claimViolations, consumeApproved, decodeCreateV2, launchViolations, type LaunchExpect } from './policy';
import { referenceClaimViolations, referenceLaunchViolations } from './policyRef';
import {
  altAccount,
  altAddress,
  BLOCKHASH,
  buildClaim,
  buildLaunch,
  compile,
  DEFAULT_META,
  expectFor,
  keysFor,
  launchIxs,
  NodeBuffer,
  prng,
  sv,
  web3,
} from './test/launchFixture';
import { decodeMessage, encodeMessage, encodeShortvec } from './txcodec';

const ref = (bytes: Uint8Array, x: LaunchExpect, placeId: string) =>
  referenceLaunchViolations(bytes, {
    attestor: x.attestor,
    launcher: x.launcher,
    mint: x.mint,
    placeId,
    name: x.name,
    symbol: x.symbol,
    uri: x.uri,
    maxDevBuyLamports: x.maxDevBuyLamports,
    alt: x.alt,
    maxComputeUnitLimit: x.maxComputeUnitLimit,
    maxComputeUnitPriceMicroLamports: x.maxComputeUnitPriceMicroLamports,
    programId: x.programId,
  });

/** Re-encodes a decoded+edited message (lets tests craft what no builder would produce). */
function edit(bytes: Uint8Array, f: (m: ReturnType<typeof decodeMessage>) => void): Uint8Array {
  const m = decodeMessage(bytes);
  f(m);
  return encodeMessage(m);
}

const sysTransfer = (from: any, to: any, lamports = 1) => web3.SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });

describe('launch policy: valid messages (exactly what CHAIN builds)', () => {
  it('accepts a launch with a dev buy; the reference checker agrees; ≤ 1,232 B with 3 signatures', async () => {
    const b = await buildLaunch();
    expect(launchViolations(b.bytes, b.expect)).toEqual([]);
    expect(await ref(b.bytes, b.expect, b.placeId)).toEqual([]);
    expect(1 + 64 * 3 + b.bytes.length).toBeLessThanOrEqual(1232);
  });

  it('accepts a launch without a dev buy (reserved 0)', async () => {
    const b = await buildLaunch({ devBuy: 0n });
    expect(launchViolations(b.bytes, b.expect)).toEqual([]);
    expect(await ref(b.bytes, b.expect, b.placeId)).toEqual([]);
  });

  it('accepts max metadata (name 32 B, symbol 10, uri 100) and stays under 1,232 B', async () => {
    const meta = { name: 'N'.repeat(32), symbol: 'ABCDEFGHIJ', uri: `https://x.example/${'u'.repeat(100 - 18)}` };
    expect(new TextEncoder().encode(meta.uri).length).toBe(100);
    const k = await keysFor('ChIJmaxmetadata0001', meta);
    const b = await buildLaunch({}, k);
    expect(launchViolations(b.bytes, b.expect)).toEqual([]);
    expect(1 + 64 * 3 + b.bytes.length).toBeLessThanOrEqual(1232);
  });

  it('accepts devnet synthetic test places and no compute-budget instructions', async () => {
    const b = await buildLaunch({ placeId: 'cornershop-test:e2e-1', noComputeBudget: true });
    expect(launchViolations(b.bytes, b.expect)).toEqual([]);
  });

  it('every derived address matches the SDK-built instruction accounts', async () => {
    const b = await buildLaunch();
    const x = b.expect;
    const create = b.ixs[2];
    const buy = b.ixs[5];
    expect(create.keys[2].pubkey.toBase58()).toBe(x.bondingCurve);
    expect(create.keys[3].pubkey.toBase58()).toBe(x.curveBaseAta);
    expect(create.keys[12].pubkey.toBase58()).toBe(x.mayhemState);
    expect(create.keys[13].pubkey.toBase58()).toBe(x.mayhemTokenVault);
    expect(buy.keys[7].pubkey.toBase58()).toBe(x.curveQuoteAta);
    expect(buy.keys[10].pubkey.toBase58()).toBe(x.launcherWsolAta);
    expect(buy.keys[11].pubkey.toBase58()).toBe(x.userVolumeAccumulator);
    const s = await sv();
    expect(x.vault).toBe(s.vaultPda(b.placeHash)[0].toBase58());
    expect(x.vaultState).toBe(s.vaultStatePda(b.placeHash)[0].toBase58());
    expect(x.config).toBe(s.configPda()[0].toBase58());
  });
});

describe('launch policy: refuses tampered instructions', () => {
  const cases: [string, () => Promise<{ bytes: Uint8Array; expect: LaunchExpect }>, RegExp][] = [
    ['changed name (moderation bypass)', () => buildLaunch({ name: 'Not Moderated' }), /name differs/],
    ['changed symbol', () => buildLaunch({ symbol: 'SCAM' }), /symbol differs/],
    ['changed metadata uri', () => buildLaunch({ uri: 'https://evil.example/m.json' }), /uri differs/],
    ['name with a BOM (same text, other bytes)', () => buildLaunch({ name: `﻿${DEFAULT_META.name}` }), /name differs/],
    ['name in NFD instead of NFC', async () => {
      const k = await keysFor('ChIJnfdtest00001', { ...DEFAULT_META, name: 'Café Crème' });
      const b = await buildLaunch({ name: 'Café Crème'.normalize('NFD') }, k);
      return b;
    }, /name differs/],
    ['creator = launcher', async () => {
      const k = await keysFor();
      return buildLaunch({ creator: k.launcher.publicKey }, k);
    }, /creator is not the place vault/],
    ['creator = the vault of another place', async () => {
      const s = await sv();
      return buildLaunch({ creator: s.vaultPda(s.placeHash('ChIJotherplace0001'))[0] });
    }, /creator is not the place vault/],
    ['mayhem mode', () => buildLaunch({ mayhem: true }), /mayhem|create_v2: account/],
    ['an extra System transfer to an attacker', () =>
      buildLaunch({ mutate: (ixs, k) => [...ixs, sysTransfer(k.launcher.publicKey, web3.Keypair.generate().publicKey, 1_000_000)] }),
      /non-budget instructions/],
    ['an instruction before the compute budget', () =>
      buildLaunch({ mutate: (ixs, k) => [sysTransfer(k.launcher.publicKey, web3.Keypair.generate().publicKey), ...ixs] }),
      /non-budget instructions|must be pump create_v2/],
    ['a second register_launch (another place) under one attestor signature', async () => {
      const s = await sv();
      return buildLaunch({
        mutate: (ixs, k) => [
          ...ixs.slice(0, 4),
          s.registerLaunch({ launcher: k.launcher.publicKey, attestor: k.attestor.publicKey, placeHash: s.placeHash('ChIJsecond00000001'), mint: k.mint.publicKey }),
        ],
        devBuy: 0n,
      });
    }, /non-budget instructions/],
    ['register_launch for another place hash', async () => {
      const s = await sv();
      return buildLaunch({
        mutate: (ixs, k) => {
          ixs[3] = s.registerLaunch({ launcher: k.launcher.publicKey, attestor: k.attestor.publicKey, placeHash: s.placeHash('ChIJotherplace0001'), mint: k.mint.publicKey });
        },
      });
    }, /register_launch data|register_launch: account/],
    ['register_launch under a look-alike program id', () =>
      buildLaunch({
        mutate: (ixs) => {
          ixs[3] = new web3.TransactionInstruction({ programId: web3.Keypair.generate().publicKey, keys: ixs[3].keys, data: ixs[3].data });
        },
      }),
      /must be shop_vault.register_launch/],
    ['register_launch with a fake Instructions sysvar', () =>
      buildLaunch({
        mutate: (ixs) => {
          const keys = ixs[3].keys.slice();
          keys[8] = { pubkey: web3.Keypair.generate().publicKey, isSigner: false, isWritable: false };
          ixs[3] = new web3.TransactionInstruction({ programId: ixs[3].programId, keys, data: ixs[3].data });
        },
      }),
      /register_launch: account 8/],
    ['register_launch with a trailing data byte', () =>
      buildLaunch({
        mutate: (ixs) => {
          ixs[3] = new web3.TransactionInstruction({ programId: ixs[3].programId, keys: ixs[3].keys, data: NodeBuffer.concat([ixs[3].data, NodeBuffer.from([0])]) });
        },
      }),
      /register_launch data/],
    ['create_v2 under a look-alike program', () =>
      buildLaunch({
        mutate: (ixs) => {
          ixs[2] = new web3.TransactionInstruction({ programId: web3.Keypair.generate().publicKey, keys: ixs[2].keys, data: ixs[2].data });
        },
      }),
      /must be pump create_v2/],
    ['create_v2 with a substituted bonding curve', () =>
      buildLaunch({
        mutate: (ixs) => {
          const keys = ixs[2].keys.slice();
          keys[2] = { ...keys[2], pubkey: web3.Keypair.generate().publicKey };
          ixs[2] = new web3.TransactionInstruction({ programId: ixs[2].programId, keys, data: ixs[2].data });
        },
      }),
      /create_v2: account 2/],
    ['create_v2 with creator_fee_bps patched to 100', () =>
      buildLaunch({
        mutate: (ixs) => {
          const d = NodeBuffer.from(ixs[2].data);
          d.writeBigUInt64LE(100n, d.length - 9);
          ixs[2] = new web3.TransactionInstruction({ programId: ixs[2].programId, keys: ixs[2].keys, data: d });
        },
      }),
      /creator_fee_bps/],
    ['create_v2 with cashback patched on', () =>
      buildLaunch({
        mutate: (ixs) => {
          const d = NodeBuffer.from(ixs[2].data);
          d[d.length - 10] = 1;
          ixs[2] = new web3.TransactionInstruction({ programId: ixs[2].programId, keys: ixs[2].keys, data: d });
        },
      }),
      /cashback/],
    ['create_v2 with holder reward patched on', () =>
      buildLaunch({
        mutate: (ixs) => {
          const d = NodeBuffer.from(ixs[2].data);
          d[d.length - 1] = 1;
          ixs[2] = new web3.TransactionInstruction({ programId: ixs[2].programId, keys: ixs[2].keys, data: d });
        },
      }),
      /holder_reward/],
    ['create_v2 data with a trailing byte', () =>
      buildLaunch({
        mutate: (ixs) => {
          ixs[2] = new web3.TransactionInstruction({ programId: ixs[2].programId, keys: ixs[2].keys, data: NodeBuffer.concat([ixs[2].data, NodeBuffer.from([0])]) });
        },
      }),
      /well-formed pump create_v2/],
    ['dev buy above the cap', () => buildLaunch({ devBuy: 2_000_000_000n }), /cap|reserved/],
    ['dev buy different from the reservation', async () => {
      const b = await buildLaunch({ devBuy: 500_000_000n });
      return { bytes: b.bytes, expect: { ...b.expect, devBuyLamports: 100_000_000n } };
    }, /!= reserved/],
    ['dev buy present although the reservation has none', async () => {
      const b = await buildLaunch({ devBuy: 100_000_000n });
      return { bytes: b.bytes, expect: { ...b.expect, devBuyLamports: 0n } };
    }, /non-budget instructions/],
    ['dev buy missing although reserved', async () => {
      const b = await buildLaunch({ devBuy: 0n });
      return { bytes: b.bytes, expect: { ...b.expect, devBuyLamports: 100_000_000n } };
    }, /non-budget instructions/],
    ['dev buy with min_tokens_out = 0', () =>
      buildLaunch({
        mutate: (ixs) => {
          const d = NodeBuffer.from(ixs[5].data);
          d.writeBigUInt64LE(0n, 16);
          ixs[5] = new web3.TransactionInstruction({ programId: ixs[5].programId, keys: ixs[5].keys, data: d });
        },
      }),
      /min_tokens_out/],
    ['dev buy with partial_fill on', () =>
      buildLaunch({
        mutate: (ixs) => {
          const d = NodeBuffer.from(ixs[5].data);
          d[24] = 1;
          ixs[5] = new web3.TransactionInstruction({ programId: ixs[5].programId, keys: ixs[5].keys, data: d });
        },
      }),
      /partial_fill/],
    ['dev buy replaced by a sell', () =>
      buildLaunch({
        mutate: (ixs) => {
          const d = NodeBuffer.from(ixs[5].data);
          NodeBuffer.from('1c92de7726c469d5', 'hex').copy(d, 0);
          ixs[5] = new web3.TransactionInstruction({ programId: ixs[5].programId, keys: ixs[5].keys, data: d });
        },
      }),
      /buy_exact_quote_in_v3/],
    ['dev buy fee recipient swapped', () =>
      buildLaunch({
        mutate: (ixs) => {
          const keys = ixs[5].keys.slice();
          keys[13] = { ...keys[13], pubkey: web3.Keypair.generate().publicKey };
          ixs[5] = new web3.TransactionInstruction({ programId: ixs[5].programId, keys, data: ixs[5].data });
        },
      }),
      /dev buy: account 13/],
    ['ATA create (non-idempotent)', () =>
      buildLaunch({
        mutate: (ixs) => {
          ixs[4] = new web3.TransactionInstruction({ programId: ixs[4].programId, keys: ixs[4].keys, data: NodeBuffer.from([]) });
        },
      }),
      /ATA CreateIdempotent/],
    ['ATA for another owner', () =>
      buildLaunch({
        mutate: (ixs) => {
          const keys = ixs[4].keys.slice();
          keys[2] = { ...keys[2], pubkey: web3.Keypair.generate().publicKey };
          ixs[4] = new web3.TransactionInstruction({ programId: ixs[4].programId, keys, data: ixs[4].data });
        },
      }),
      /ATA: account 2/],
    ['compute unit limit above 600k', () => buildLaunch({ cuLimit: 1_400_000 }), /compute unit limit/],
    ['compute unit price above the cap', () => buildLaunch({ cuPrice: 50_000_000 }), /compute unit price/],
    ['a duplicate compute-budget instruction', () =>
      buildLaunch({ mutate: (ixs) => [web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ...ixs] }),
      /duplicate compute budget/],
    ['a heap-frame request', () =>
      buildLaunch({ mutate: (ixs) => [web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }), ...ixs] }),
      /kind 1/],
    ['a compute-budget instruction after create_v2', () =>
      buildLaunch({ mutate: (ixs) => [...ixs.slice(2, 3), ...ixs.slice(0, 2), ...ixs.slice(3)] }),
      /must be pump create_v2|non-budget/],
    ['the attestor referenced by a second instruction', () =>
      buildLaunch({
        mutate: (ixs, k) => {
          const keys = ixs[4].keys.slice();
          keys.push({ pubkey: k.attestor.publicKey, isSigner: false, isWritable: false });
          ixs[4] = new web3.TransactionInstruction({ programId: ixs[4].programId, keys, data: ixs[4].data });
        },
      }),
      /attestor referenced|ATA: 7 accounts/],
    ['the attestor as a writable signer', () =>
      buildLaunch({
        mutate: (ixs, k) => {
          const keys = ixs[3].keys.slice();
          keys[1] = { pubkey: k.attestor.publicKey, isSigner: true, isWritable: true };
          ixs[3] = new web3.TransactionInstruction({ programId: ixs[3].programId, keys, data: ixs[3].data });
        },
      }),
      /numReadonlySignedAccounts|signer/],
  ];
  for (const [name, build, re] of cases) {
    it(`refuses: ${name}`, async () => {
      const b = await build();
      const v = launchViolations(b.bytes, b.expect);
      expect(v.length, `expected a violation for "${name}"`).toBeGreaterThan(0);
      expect(v.join('\n')).toMatch(re);
    });
  }

  it('refuses the wrong fee payer (attestor pays, mint pays, a stranger pays)', async () => {
    const k = await keysFor();
    for (const payer of [k.attestor.publicKey, k.mint.publicKey, web3.Keypair.generate().publicKey]) {
      const b = await buildLaunch({ payer }, k);
      expect(launchViolations(b.bytes, b.expect).join('\n')).toMatch(/fee payer|numRequiredSignatures|signer/);
    }
  });

  it('refuses a launch reserved for another launcher or another mint', async () => {
    const b = await buildLaunch();
    expect(launchViolations(b.bytes, { ...b.expect, launcher: web3.Keypair.generate().publicKey.toBase58() }).join()).toMatch(/fee payer/);
    expect(launchViolations(b.bytes, { ...b.expect, mint: web3.Keypair.generate().publicKey.toBase58() }).join()).toMatch(/reserved mint/);
    expect(launchViolations(b.bytes, { ...b.expect, attestor: web3.Keypair.generate().publicKey.toBase58() }).join()).toMatch(/attestor/);
  });

  it('refuses when the reservation is for another place (vault, vault_state, hash)', async () => {
    const b = await buildLaunch();
    const other = await keysFor('ChIJanotherplace001');
    const ox = await expectFor({ ...other, launcher: b.launcher, mint: b.mint, attestor: b.attestor }, 100_000_000n);
    const v = launchViolations(b.bytes, ox);
    expect(v.join('\n')).toMatch(/creator is not the place vault/);
    expect(v.join('\n')).toMatch(/register_launch data/);
  });
});

describe('launch policy: lookup-table tricks', () => {
  it('refuses a look-alike lookup table (same keys, other address)', async () => {
    const b = await buildLaunch({ alts: [altAccount(web3.Keypair.generate().publicKey.toBase58())] });
    expect(launchViolations(b.bytes, b.expect).join()).toMatch(/unknown lookup table/);
  });

  it('refuses two lookup tables', async () => {
    const extraKey = web3.Keypair.generate().publicKey;
    const alt2 = altAccount(web3.Keypair.generate().publicKey.toBase58(), [extraKey.toBase58()]);
    const b = await buildLaunch({
      alts: [altAccount(), alt2],
      mutate: (ixs) => {
        const keys = ixs[4].keys.slice();
        keys.push({ pubkey: extraKey, isSigner: false, isWritable: false });
        ixs[4] = new web3.TransactionInstruction({ programId: ixs[4].programId, keys, data: ixs[4].data });
      },
    });
    expect(launchViolations(b.bytes, b.expect).join()).toMatch(/more than one address lookup table/);
  });

  it('refuses a lookup when no ALT is configured, and when the ALT holds other keys', async () => {
    const b = await buildLaunch();
    expect(launchViolations(b.bytes, { ...b.expect, alt: null }).join()).toMatch(/none is configured/);
    const shifted = [...ALT_KEYS.slice(1), ALT_KEYS[0]!];
    const v = launchViolations(b.bytes, { ...b.expect, alt: { address: altAddress(), keys: shifted } });
    expect(v.length).toBeGreaterThan(0);
  });

  it('refuses an out-of-range lookup index, an empty lookup, and a loaded duplicate of a static key', async () => {
    const b = await buildLaunch();
    const oob = edit(b.bytes, (m) => {
      m.addressTableLookups[0]!.readonlyIndexes[0] = 200;
    });
    expect(launchViolations(oob, b.expect).join()).toMatch(/out of range/);
    const empty = edit(b.bytes, (m) => {
      m.addressTableLookups.push({ accountKey: m.addressTableLookups[0]!.accountKey, writableIndexes: [], readonlyIndexes: [] });
    });
    expect(launchViolations(empty, b.expect).length).toBeGreaterThan(0);
    // load ALT index 10 (System program) although it is also static? It is loaded already; load index 0 twice instead
    const dup = edit(b.bytes, (m) => {
      const l = m.addressTableLookups[0]!;
      l.readonlyIndexes.push(l.readonlyIndexes[0]!);
    });
    expect(launchViolations(dup, b.expect).join()).toMatch(/duplicate account/);
  });

  it('refuses a program id loaded from the lookup table', async () => {
    const b = await buildLaunch();
    const m = decodeMessage(b.bytes);
    const loadedIndex = m.staticAccountKeys.length; // first loaded account
    const bad = edit(b.bytes, (mm) => {
      mm.instructions[3]!.programIdIndex = loadedIndex;
    });
    expect(launchViolations(bad, b.expect).join()).toMatch(/program id must be a static/);
  });
});

describe('launch policy: message encoding edge cases', () => {
  it('refuses legacy messages, version 1, trailing bytes, truncation, empty input and transaction bytes', async () => {
    const b = await buildLaunch();
    const legacy = new Uint8Array(
      new web3.Transaction({ feePayer: b.launcher.publicKey, recentBlockhash: BLOCKHASH }).add(...b.ixs.slice(0, 4)).compileMessage().serialize(),
    );
    expect(launchViolations(legacy, b.expect).join()).toMatch(/v0|undecodable|1,232|1232/);
    const v1 = b.bytes.slice();
    v1[0] = 0x81;
    expect(launchViolations(v1, b.expect).join()).toMatch(/unsupported message version/);
    expect(launchViolations(Uint8Array.from([...b.bytes, 0]), b.expect).join()).toMatch(/trailing bytes/);
    expect(launchViolations(b.bytes.subarray(0, b.bytes.length - 3), b.expect).join()).toMatch(/truncated|undecodable/);
    expect(launchViolations(new Uint8Array(0), b.expect).join()).toMatch(/empty/);
    const tx = new web3.VersionedTransaction(b.message);
    expect(launchViolations(new Uint8Array(tx.serialize()), b.expect).length).toBeGreaterThan(0);
  });

  it('refuses a non-minimal compact-u16 length (same message, other bytes)', async () => {
    const b = await buildLaunch();
    // static key count n < 128 is one byte; re-encode it as two (n|0x80, 0x00)
    const n = b.bytes[4]!;
    expect(n).toBeLessThan(128);
    const bad = Uint8Array.from([...b.bytes.subarray(0, 4), n | 0x80, 0x00, ...b.bytes.subarray(5)]);
    expect(launchViolations(bad, b.expect).join()).toMatch(/non-minimal/);
    expect(encodeShortvec(n)).toEqual(Uint8Array.of(n));
  });

  it('refuses a message over the 1,232 B limit before decoding', async () => {
    const b = await buildLaunch();
    const big = new Uint8Array(1100);
    big.set(b.bytes);
    expect(launchViolations(big, b.expect).join()).toMatch(/limit 1232/);
  });

  it('refuses header manipulations (signer counts, read-only counts beyond the keys)', async () => {
    const b = await buildLaunch();
    for (const [i, v] of [
      [1, 4],
      [1, 2],
      [2, 0],
      [2, 2],
      [2, 3],
      [3, 250],
    ] as const) {
      const bad = b.bytes.slice();
      bad[i] = v;
      expect(launchViolations(bad, b.expect).length, `header byte ${i}=${v}`).toBeGreaterThan(0);
    }
  });

  it('refuses a duplicated signer key', async () => {
    const b = await buildLaunch();
    const dup = edit(b.bytes, (m) => {
      m.staticAccountKeys[1] = m.staticAccountKeys[0]!;
    });
    expect(launchViolations(dup, b.expect).join()).toMatch(/duplicate account/);
  });

  it('refuses any account with the wrong writability (Config, pump Global, a program, the fee config)', async () => {
    const flip = (ixIndex: number, keyIndex: number, writable: boolean) => (ixs: any[]) => {
      const keys = ixs[ixIndex].keys.map((k: any, i: number) => (i === keyIndex ? { ...k, isWritable: writable } : k));
      ixs[ixIndex] = new web3.TransactionInstruction({ programId: ixs[ixIndex].programId, keys, data: ixs[ixIndex].data });
    };
    // [budget, budget, create_v2, register_launch, ATA, buy]
    const cases: [string, number, number, boolean, number?][] = [
      ['Config writable (register_launch #2)', 3, 2, true],
      ['pump Global writable (create_v2 #4)', 2, 4, true],
      ['pump Global writable (buy #0)', 5, 0, true],
      ['fee config writable (buy #12)', 5, 12, true],
      ['instructions sysvar writable', 3, 8, true],
      ['Config writable without a dev buy', 3, 2, true, 0],
    ];
    for (const [what, ix, key, w, devBuy] of cases) {
      const k = await keysFor();
      const b = await buildLaunch({ ...(devBuy === 0 ? { devBuy: 0n } : {}), mutate: flip(ix, key, w) }, k);
      expect(launchViolations(b.bytes, b.expect).join(), what).toMatch(/must be read-only/);
    }
    // a read-only demotion of an account the launch writes is refused too (the bonding curve, via the ALT or static)
    const k = await keysFor();
    const demote = (ixs: any[]) => {
      for (const i of [2, 3, 5]) {
        const curve = ixs[2].keys[2].pubkey.toBase58();
        const keys = ixs[i].keys.map((m: any) => (m.pubkey.toBase58() === curve ? { ...m, isWritable: false } : m));
        ixs[i] = new web3.TransactionInstruction({ programId: ixs[i].programId, keys, data: ixs[i].data });
      }
    };
    const d = await buildLaunch({ mutate: demote }, k);
    expect(launchViolations(d.bytes, d.expect).join()).toMatch(/must be writable/);
  });
});

describe('launch policy: seeded fuzzing', () => {
  it('a random byte mutation is accepted only in the blockhash or compute-budget values; never a reference disagreement', async () => {
    const b = await buildLaunch();
    const m = decodeMessage(b.bytes);
    // offsets of the bytes a mutation may legitimately change: recent blockhash, CB limit/price values
    const nKeys = m.staticAccountKeys.length;
    const bhStart = 1 + 3 + 1 + 32 * nKeys;
    const allowed = new Set<number>();
    for (let i = 0; i < 32; i++) allowed.add(bhStart + i);
    // CB ix 0: [progIdx, 0 accounts, len 5, 02, u32]; ix 1: [progIdx, 0, len 9, 03, u64]
    let o = bhStart + 32 + 1; // after the ix count
    for (let ix = 0; ix < 2; ix++) {
      const len = b.bytes[o + 2]!;
      for (let j = 1; j < len; j++) allowed.add(o + 3 + j);
      o += 3 + len;
    }
    // dev buy min_tokens_out (only the launcher's own slippage bound on a curve created in the same tx): any value ≥ 1
    for (const ix of m.instructions.slice(2, 5)) {
      o += 1 + 1 + ix.accountKeyIndexes.length + (ix.data.length < 128 ? 1 : 2) + ix.data.length;
    }
    {
      const ix5 = m.instructions[5]!;
      const dataStart = o + 1 + 1 + ix5.accountKeyIndexes.length + 1;
      for (let j = 16; j < 24; j++) allowed.add(dataStart + j);
    }
    const rnd = prng(0xc0ffee);
    let accepted = 0;
    for (let iter = 0; iter < 1500; iter++) {
      const bad = b.bytes.slice();
      const pos = Math.floor(rnd() * bad.length);
      let val = Math.floor(rnd() * 256);
      if (val === bad[pos]) val = (val + 1) & 0xff;
      bad[pos] = val;
      const v = launchViolations(bad, b.expect);
      if (v.length === 0) {
        accepted++;
        expect(allowed.has(pos), `mutation at ${pos} accepted`).toBe(true);
        expect(await ref(bad, b.expect, b.placeId)).toEqual([]);
      }
    }
    expect(accepted).toBeGreaterThan(0); // blockhash mutations are fine
  }, 60_000);

  it('random truncations, insertions and deletions are always refused', async () => {
    const b = await buildLaunch();
    const rnd = prng(42);
    for (let iter = 0; iter < 600; iter++) {
      const kind = iter % 3;
      let bad: Uint8Array;
      const pos = Math.floor(rnd() * b.bytes.length);
      if (kind === 0) bad = b.bytes.subarray(0, pos);
      else if (kind === 1) bad = Uint8Array.from([...b.bytes.subarray(0, pos), Math.floor(rnd() * 256), ...b.bytes.subarray(pos)]);
      else bad = Uint8Array.from([...b.bytes.subarray(0, pos), ...b.bytes.subarray(pos + 1)]);
      expect(launchViolations(bad, b.expect).length, `${['truncate', 'insert', 'delete'][kind]} at ${pos}`).toBeGreaterThan(0);
    }
  });

  it('random account-index rewiring inside instructions is always refused', async () => {
    const b = await buildLaunch();
    const rnd = prng(7);
    const m0 = decodeMessage(b.bytes);
    const total = m0.staticAccountKeys.length + m0.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0);
    for (let iter = 0; iter < 400; iter++) {
      const bad = edit(b.bytes, (m) => {
        const ix = m.instructions[2 + Math.floor(rnd() * (m.instructions.length - 2))]!;
        const j = Math.floor(rnd() * ix.accountKeyIndexes.length);
        let v = Math.floor(rnd() * total);
        if (v === ix.accountKeyIndexes[j]) v = (v + 1) % total;
        ix.accountKeyIndexes[j] = v;
      });
      expect(launchViolations(bad, b.expect).length).toBeGreaterThan(0);
    }
  });
});

describe('create_v2 decoder', () => {
  it('decodes SDK data and refuses malformed lengths', async () => {
    const k = await keysFor();
    const ixs = await launchIxs(k);
    const d = new Uint8Array(ixs[2].data);
    const a = decodeCreateV2(d)!;
    expect(new TextDecoder().decode(a.name)).toBe(k.name);
    expect(b58encode(a.creator)).toBe(k.vault.toBase58());
    expect(a.creatorFeeBps).toBe(0n);
    expect(decodeCreateV2(d.subarray(0, d.length - 1))).toBeNull();
    const huge = d.slice();
    huge.set(u64le(0xffffffffn).subarray(0, 4), 8);
    expect(decodeCreateV2(huge)).toBeNull();
  });
});

describe('claim policy', () => {
  it('accepts the request_claim CHAIN builds; the reference checker agrees', async () => {
    const c = await buildClaim();
    expect(claimViolations(c.bytes, c.expect)).toEqual([]);
    expect(
      await referenceClaimViolations(c.bytes, {
        attestor: c.expect.attestor,
        newOwner: c.expect.newOwner,
        placeId: c.placeId,
        expectedNonce: 1n,
        maxComputeUnitLimit: c.expect.maxComputeUnitLimit,
        maxComputeUnitPriceMicroLamports: c.expect.maxComputeUnitPriceMicroLamports,
        programId: SHOP_VAULT_PROGRAM_ID,
      }),
    ).toEqual([]);
  });

  it('refuses a stale or future nonce', async () => {
    expect(claimViolations((await buildClaim({ nonce: 2n, expectedNonce: 1n })).bytes, (await buildClaim({ expectedNonce: 1n })).expect).length).toBeGreaterThan(0);
    const c = await buildClaim({ nonce: 1n, expectedNonce: 2n });
    expect(claimViolations(c.bytes, c.expect).join()).toMatch(/nonce/);
  });

  it('refuses a claim for another place', async () => {
    const c = await buildClaim({ placeId: 'ChIJclaimother00001' });
    const s = await sv();
    const x = { ...c.expect, vaultState: s.vaultStatePda(s.placeHash('ChIJN1t_tDeuEmsRUsoyG83frY4'))[0].toBase58() };
    expect(claimViolations(c.bytes, x).join()).toMatch(/request_claim: account 3/);
  });

  it('refuses extra instructions, a second claim, a relayer fee payer and the attestor as fee payer', async () => {
    const s = await sv();
    const extra = await buildClaim({ mutate: (ixs, k) => [...ixs, sysTransfer(k.newOwner.publicKey, web3.Keypair.generate().publicKey)] });
    expect(claimViolations(extra.bytes, extra.expect).join()).toMatch(/exactly one request_claim/);
    const two = await buildClaim({
      mutate: (ixs, k) => [...ixs, s.requestClaim({ attestor: k.attestor.publicKey, newOwner: k.newOwner.publicKey, placeHash: s.placeHash('ChIJx0000000000002'), nonce: 1n })],
    });
    expect(claimViolations(two.bytes, two.expect).length).toBeGreaterThan(0);
    const relayed = await buildClaim({ payer: web3.Keypair.generate().publicKey });
    expect(claimViolations(relayed.bytes, relayed.expect).join()).toMatch(/fee payer|numRequiredSignatures/);
  });

  it('refuses a claim message that uses a lookup table, or a legacy message', async () => {
    const c = await buildClaim();
    const withAlt = edit(c.bytes, (m) => {
      m.addressTableLookups.push({ accountKey: decodeMessage(c.bytes).staticAccountKeys[0]!, writableIndexes: [], readonlyIndexes: [0] });
    });
    expect(claimViolations(withAlt, c.expect).join()).toMatch(/lookup table/);
    const legacy = edit(c.bytes, (m) => {
      m.version = 'legacy';
      m.addressTableLookups = [];
    });
    expect(claimViolations(legacy, c.expect).join()).toMatch(/v0/);
  });

  it('refuses a claim that write-locks Config (exact writability)', async () => {
    const c = await buildClaim({
      mutate: (ixs) => {
        const keys = ixs[2].keys.map((m: any, i: number) => (i === 2 ? { ...m, isWritable: true } : m));
        ixs[2] = new web3.TransactionInstruction({ programId: ixs[2].programId, keys, data: ixs[2].data });
      },
    });
    expect(claimViolations(c.bytes, c.expect).join()).toMatch(/must be read-only/);
  });

  it('refuses the attestor referenced twice or the new owner swapped', async () => {
    const c = await buildClaim({
      mutate: (ixs, k) => {
        const keys = ixs[2].keys.slice();
        keys.push({ pubkey: k.attestor.publicKey, isSigner: false, isWritable: false });
        ixs[2] = new web3.TransactionInstruction({ programId: ixs[2].programId, keys, data: ixs[2].data });
      },
    });
    expect(claimViolations(c.bytes, c.expect).join()).toMatch(/attestor referenced|5 accounts|6 accounts/);
    const d = await buildClaim();
    expect(claimViolations(d.bytes, { ...d.expect, newOwner: web3.Keypair.generate().publicKey.toBase58() }).join()).toMatch(/fee payer/);
  });

  it('fuzz: random byte mutations outside the blockhash / budget values are refused', async () => {
    const c = await buildClaim();
    const m = decodeMessage(c.bytes);
    const bhStart = 1 + 3 + 1 + 32 * m.staticAccountKeys.length;
    const rnd = prng(99);
    for (let iter = 0; iter < 800; iter++) {
      const bad = c.bytes.slice();
      const pos = Math.floor(rnd() * bad.length);
      bad[pos] = (bad[pos]! + 1 + Math.floor(rnd() * 255)) & 0xff;
      const v = claimViolations(bad, c.expect);
      if (v.length === 0) {
        const inBlockhash = pos >= bhStart && pos < bhStart + 32;
        const inBudget = pos > bhStart + 32 && pos < bhStart + 32 + 1 + 3 + 5 + 3 + 9;
        expect(inBlockhash || inBudget, `mutation at ${pos} accepted`).toBe(true);
      }
    }
  });
});

describe('approval tokens (H7)', () => {
  it('signs only approved messages, exactly once, and exactly the checked bytes', async () => {
    __clearKeyCache();
    const b = await buildLaunch();
    const secret = NodeBuffer.from(b.attestor.secretKey).toString('base64');
    const env = { ATTESTOR_SECRET: secret } as never;
    const { signApproved } = await import('./attestor');
    const input = b.bytes.slice();
    const a = await approveLaunch(input, b.expect, (bytes) => ref(bytes, b.expect, b.placeId));
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    input[100] ^= 0xff; // mutating the caller's buffer after approval changes nothing
    const { signature, attestor } = await signApproved(env, a.approved);
    expect(attestor).toBe(b.attestor.publicKey.toBase58());
    const nacl = (await import('./test/launchFixture')).web3;
    const tx = new nacl.VersionedTransaction(b.message);
    tx.addSignature(b.attestor.publicKey, NodeBuffer.from(signature));
    // verify the attestor signature over the ORIGINAL message bytes with WebCrypto
    const pub = await crypto.subtle.importKey('raw', b.attestor.publicKey.toBytes(), { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, pub, signature, b.bytes)).toBe(true);
    await expect(signApproved(env, a.approved)).rejects.toThrow(/unapproved/);
    await expect(signApproved(env, { kind: 'launch', length: 3 } as never)).rejects.toThrow(/unapproved/);
    expect(() => consumeApproved({ kind: 'claim', length: 1 })).toThrow(/unapproved/);
  });

  it('a reference-gate failure blocks the approval', async () => {
    const b = await buildLaunch();
    const a = await approveLaunch(b.bytes, b.expect, async () => ['nope']);
    expect(a).toEqual({ ok: false, violations: ['reference: nope'] });
    const thrown = await approveLaunch(b.bytes, b.expect, async () => {
      throw new Error('boom');
    });
    expect(thrown.ok).toBe(false);
    const c = await buildClaim();
    expect((await approveClaim(c.bytes, { ...c.expect, expectedNonce: 5n })).ok).toBe(false);
  });

  it('place hash vector (SPEC §3.1)', async () => {
    const k = await keysFor('ChIJN1t_tDeuEmsRUsoyG83frY4');
    expect(toHex(k.placeHash)).toBe('52791f4bf8f035bc928405e161a4c28a262db717cfe91ae8d3615563066afa15');
    expect(compile).toBeTypeOf('function');
  });
});
