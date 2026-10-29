/**
 * The launch transaction: exact SPEC §8.1 shape through the ALT, ≤ 1,232 B, passes the Worker's §8.4 policy
 * (`checkLaunchMessage`) byte for byte, and the full `launchCoin` flow against a stub Worker + fake RPC.
 */
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { AddressLookupTableAccount, Keypair, PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import * as sv from '@cornershop/shop-vault-client';
import BN from 'bn.js';
import type { ConfigResponse, LaunchPrepareResponse } from '../../worker/wire';
import fixture from './__fixtures__/devnet.json';
import { ALT_KEYS, PUMP_FEE_CONFIG, PUMP_GLOBAL, TX_SIZE_LIMIT } from './constants';
import { initChain } from './context';
import { compileLaunchMessage, estimateLaunchCost, launchCoin, launchInstructions, userVolumeAccumulatorPda } from './launch';
import { makePumpOps, type PumpSdkModule } from './pumpOps';
import { attestorSignature, keypairSigner } from './__e2e__/helpers';
import { installFakeRpc, wireAccount } from './__e2e__/fakeRpc';
import { b64ToBytes, bytesToB64 } from './rpc';
import type { ChainBackend } from './api';
import type { TxProgress } from './types';

vi.mock('../mode', () => ({
  BUILD_CLUSTER: 'devnet',
  TEST_WALLET_BUILD: false,
  APP_MODE: 'real',
  IS_REAL: true,
  CLUSTER: 'devnet',
  assertRealMode: () => {},
}));

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pumpSdk = require('@pump-fun/pump-sdk') as PumpSdkModule;
const ops = makePumpOps(pumpSdk, BN);
const RENT_PER_BYTE = BigInt(fixture.rent0) / 128n; // devnet: 5,080
const rent = (size: number) => (BigInt(size) + 128n) * RENT_PER_BYTE;

/** A frozen ALT holding exactly ALT_KEYS (web3 AddressLookupTableAccount layout: 56-byte meta + keys). */
function altAccountBytes(): Uint8Array {
  const meta = new Uint8Array(56);
  const v = new DataView(meta.buffer);
  v.setUint32(0, 1, true); // typeIndex = LookupTable
  v.setBigUint64(4, 0xffff_ffff_ffff_ffffn, true); // deactivationSlot = u64::MAX (active)
  v.setBigUint64(12, 1n, true); // lastExtendedSlot
  meta[20] = 0; // lastExtendedSlotStartIndex
  meta[21] = 0; // authority: None (frozen)
  const keys = ALT_KEYS.map((k) => new PublicKey(k).toBytes());
  const out = new Uint8Array(56 + 32 * keys.length);
  out.set(meta, 0);
  keys.forEach((k, i) => out.set(k, 56 + 32 * i));
  return out;
}
const ALT_ADDRESS = Keypair.generate().publicKey;
const alt = new AddressLookupTableAccount({ key: ALT_ADDRESS, state: AddressLookupTableAccount.deserialize(altAccountBytes()) });

describe('launch message (SPEC §8.1 / §8.4)', () => {
  const launcher = Keypair.generate().publicKey;
  const attestor = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const placeId = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
  const placeHash = sv.placeHash(placeId);
  const [vault] = sv.vaultPda(placeHash);

  const cases = [
    { label: 'typical metadata + dev buy', name: 'Corner Cafe Kebab', symbol: 'KEBAB', uri: `https://cornershop.tiejiucai.workers.dev/meta/${'a'.repeat(32)}.json`, dev: 100_000_000n },
    { label: 'max metadata (32 B name, 10 B symbol, 100 B uri) + 1 SOL dev buy', name: 'N'.repeat(32), symbol: 'ABCDEFGHIJ', uri: `https://x.y/${'u'.repeat(88)}`, dev: 1_000_000_000n },
    { label: 'no dev buy', name: 'Corner Cafe', symbol: 'CAFE', uri: `https://cornershop-devnet.tiejiucai.workers.dev/meta/${'b'.repeat(32)}.json`, dev: 0n },
  ];
  for (const c of cases) {
    test(`${c.label}: ≤ 1,232 B and passes checkLaunchMessage`, async () => {
      expect(new TextEncoder().encode(c.uri).length).toBeLessThanOrEqual(100);
      const ixs = await launchInstructions(ops, {
        launcher,
        mint,
        attestor,
        placeHash,
        vault,
        name: c.name,
        symbol: c.symbol,
        uri: c.uri,
        devBuyLamports: c.dev,
        computeUnitLimit: 400_000,
        priorityFeeMicroLamports: 10_000,
      });
      expect(ixs.length).toBe(c.dev > 0n ? 6 : 4);
      const msg = compileLaunchMessage(ixs, launcher, '11111111111111111111111111111111', alt);
      const size = new VersionedTransaction(msg).serialize().length;
      expect(size).toBeLessThanOrEqual(TX_SIZE_LIMIT);
      expect(msg.header.numRequiredSignatures).toBe(3);
      // The Worker re-deserializes and requires a canonical re-serialization.
      const bytes = msg.serialize();
      const round = VersionedMessage.deserialize(bytes);
      expect(Buffer.from(round.serialize()).equals(Buffer.from(bytes))).toBe(true);
      const violations = sv.checkLaunchMessage(round, {
        attestor,
        launcher,
        mint,
        placeId,
        name: c.name,
        symbol: c.symbol,
        uri: c.uri,
        maxDevBuyLamports: 1_000_000_000n,
        lookupTable: alt,
        maxComputeUnitLimit: 600_000,
        maxComputeUnitPriceMicroLamports: 5_000_000n,
      });
      expect(violations).toEqual([]);
      // A message whose create_v2 name differs from the moderated one is refused.
      const bad = sv.checkLaunchMessage(round, { attestor, launcher, mint, placeId, name: 'Other', symbol: c.symbol, uri: c.uri, maxDevBuyLamports: 1_000_000_000n, lookupTable: alt });
      expect(bad.some((v) => /name differs/.test(v))).toBe(true);
      console.log(`  launch tx (${c.label}): ${size} B`);
    });
  }
});

/* ------------------------------------------------------------------------------------------ flow */

const config: ConfigResponse = {
  cluster: 'devnet',
  genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  publicOrigin: 'https://cornershop-devnet.tiejiucai.workers.dev',
  programId: sv.SHOP_VAULT_PROGRAM_ID.toBase58(),
  configPda: sv.configPda()[0].toBase58(),
  alt: ALT_ADDRESS.toBase58(),
  attestor: '',
  claimWindowSecs: 60,
  launchesPaused: false,
  probationUntil: 0,
  maxDevBuyLamports: '1000000000',
  priorityFeeMicroLamports: 10_000,
  curve: { initialVirtualTokenReserves: '0', initialVirtualQuoteReserves: '0', initialRealTokenReserves: '793100000000000', tokenTotalSupply: '1000000000000000000' },
  solUsd: 150,
  solUsdAt: Date.now(),
  features: { testWallet: true, faucet: true, privy: false, phoneVerification: 'screen', turnstileSiteKey: null, jupiter: false, websiteVerification: false },
  explorer: { tx: 'https://solscan.io/tx/{sig}?cluster=devnet', address: 'https://solscan.io/account/{address}?cluster=devnet', token: 'https://solscan.io/token/{mint}?cluster=devnet' },
  buildId: 'test',
};

describe('estimateLaunchCost vs a measured devnet launch', () => {
  beforeAll(() => {
    initChain({ ...config, attestor: Keypair.generate().publicKey.toBase58() }, { rpcUrl: 'http://fake-rpc.test/', pumpSdk });
  });

  test('rent = exactly what the devnet create_v2 launch funded (6 accounts)', async () => {
    const accumulatorExists = true; // the fixture's launcher had traded before (no accumulator created)
    installFakeRpc((method, params) => {
      if (method === 'getMinimumBalanceForRentExemption') return Number(rent(params[0] as number));
      if (method === 'getMultipleAccounts') {
        const keys = params[0] as string[];
        return {
          context: { slot: 1 },
          value: keys.map((k) =>
            k === PUMP_GLOBAL ? wireAccount(b64ToBytes(fixture.global), pumpSdk.PUMP_PROGRAM_ID.toBase58()) : k === PUMP_FEE_CONFIG ? wireAccount(b64ToBytes(fixture.feeConfig), 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ') : accumulatorExists ? wireAccount(new Uint8Array(137), pumpSdk.PUMP_PROGRAM_ID.toBase58()) : null,
          ),
        };
      }
      throw new Error(`unexpected ${method}`);
    });
    // Decode the fixture's create_v2 args for the real name/symbol/uri lengths.
    const args = sv.decodeCreateV2Args(Buffer.from(fixture.create!.argsHex, 'hex'));
    const est = await estimateLaunchCost(10_000_000n, { name: args.name, symbol: args.symbol, uri: args.uri, launcher: Keypair.generate().publicKey.toBase58() });
    const created = fixture.create!.created as { address: string; lamports: number; size: number }[];
    const measuredRent = created.reduce((s, c) => s + rent(c.size), 0n);
    expect(est.rentLamports).toBe(measuredRent);
    expect(est.feeLamports).toBe(15_000n + 4_000n); // 3 signatures + 400k CU × 10,000 µL
    expect(est.devBuyTokensEstimate).toBeGreaterThan(0n);
  });

  test('a first-time launcher also pays pump’s UserVolumeAccumulator (worst case when unknown)', async () => {
    installFakeRpc((method, params) => {
      if (method === 'getMinimumBalanceForRentExemption') return Number(rent(params[0] as number));
      if (method === 'getMultipleAccounts') return { context: { slot: 1 }, value: (params[0] as string[]).map(() => null) };
      throw new Error(`unexpected ${method}`);
    });
    const known = await estimateLaunchCost(10_000_000n, { name: 'A', symbol: 'AA', uri: 'https://x/y', launcher: Keypair.generate().publicKey.toBase58() });
    const unknown = await estimateLaunchCost(10_000_000n, { name: 'A', symbol: 'AA', uri: 'https://x/y' });
    expect(known.rentLamports).toBe(unknown.rentLamports);
    const noBuy = await estimateLaunchCost(0n, { name: 'A', symbol: 'AA', uri: 'https://x/y' });
    expect(unknown.rentLamports - noBuy.rentLamports).toBe(rent(170) + rent(137));
  });

  test('userVolumeAccumulatorPda matches the SDK', () => {
    const u = Keypair.generate().publicKey;
    expect(userVolumeAccumulatorPda(u).toBase58()).toBe(pumpSdk.userVolumeAccumulatorPda(u).toBase58());
  });
});

describe('launchCoin flow (stub Worker + fake RPC)', () => {
  test('metadata → prepare → build → cosign → simulate → sign → send → confirm → register', async () => {
    const attestorKp = Keypair.generate();
    const launcherKp = Keypair.generate();
    initChain({ ...config, attestor: attestorKp.publicKey.toBase58() }, { rpcUrl: 'http://fake-rpc.test/', pumpSdk });
    const placeId = 'cornershop-test:unit-launch';
    const ph = sv.placeHash(placeId);
    let sentTx: VersionedTransaction | null = null;
    let cosigned: Uint8Array | null = null;
    let prepared: LaunchPrepareResponse | null = null;
    const backend: ChainBackend = {
      uploadMetadata: async (m) => ({ metadataId: 'a'.repeat(32), uri: `${config.publicOrigin}/meta/${'a'.repeat(32)}.json`, imageUrl: 'x', name: m.name, symbol: m.symbol }),
      launchPrepare: async (r) =>
        (prepared = {
          reservationId: 'res1',
          placeId: r.placeId,
          placeHash: sv.toHex(ph),
          vault: sv.vaultPda(ph)[0].toBase58(),
          vaultState: sv.vaultStatePda(ph)[0].toBase58(),
          name: 'Unit Cafe',
          symbol: 'UNIT',
          uri: `${config.publicOrigin}/meta/${'a'.repeat(32)}.json`,
          attestor: attestorKp.publicKey.toBase58(),
          alt: ALT_ADDRESS.toBase58(),
          programId: sv.SHOP_VAULT_PROGRAM_ID.toBase58(),
          configPda: sv.configPda()[0].toBase58(),
          maxDevBuyLamports: '1000000000',
          computeUnitLimit: 400_000,
          priorityFeeMicroLamports: 10_000,
          blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',
          lastValidBlockHeight: 1_000,
          expiresAt: Date.now() + 120_000,
        }),
      launchCosign: async (r) => {
        const bytes = b64ToBytes(r.messageBase64);
        const msg = VersionedMessage.deserialize(bytes);
        const v = sv.checkLaunchMessage(msg, {
          attestor: attestorKp.publicKey,
          launcher: launcherKp.publicKey,
          mint: new PublicKey(msg.staticAccountKeys[1]),
          placeId,
          name: prepared!.name,
          symbol: prepared!.symbol,
          uri: prepared!.uri,
          maxDevBuyLamports: 1_000_000_000n,
          lookupTable: alt,
        });
        expect(v).toEqual([]);
        cosigned = bytes;
        return { attestor: attestorKp.publicKey.toBase58(), attestorSignature: attestorSignature(attestorKp, msg), lockedUntil: Date.now() + 120_000 };
      },
      launchConfirm: async () => ({ status: 'registered', coin: { placeId, mint: 'M' } as never }),
      claimCosign: async () => {
        throw new Error('n/a');
      },
      claimConfirm: async () => {
        throw new Error('n/a');
      },
      indexTx: async () => null,
    };
    initChain({ ...config, attestor: attestorKp.publicKey.toBase58() }, { backend });
    const rpc = installFakeRpc((method, params) => {
      switch (method) {
        case 'getAccountInfo':
          return { context: { slot: 1 }, value: wireAccount(altAccountBytes(), 'AddressLookupTab1e1111111111111111111111111') };
        case 'getMinimumBalanceForRentExemption':
          return Number(rent(params[0] as number));
        case 'getMultipleAccounts':
          return {
            context: { slot: 1 },
            value: (params[0] as string[]).map((k) =>
              k === PUMP_GLOBAL ? wireAccount(b64ToBytes(fixture.global), pumpSdk.PUMP_PROGRAM_ID.toBase58()) : k === PUMP_FEE_CONFIG ? wireAccount(b64ToBytes(fixture.feeConfig), 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ') : null,
            ),
          };
        case 'simulateTransaction':
          return { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 190_000 } };
        case 'sendTransaction':
          sentTx = VersionedTransaction.deserialize(b64ToBytes(params[0] as string));
          return 'sig';
        case 'getSignatureStatuses':
          return { context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] };
        case 'getBlockHeight':
          return 900;
        case 'getTransaction':
          return null;
        default:
          throw new Error(`unexpected ${method}`);
      }
    });
    const phases: TxProgress[] = [];
    const out = await launchCoin(
      { placeId, name: 'Unit Cafe', ticker: 'UNIT', description: '', category: 'cafe', emoji: '☕', bg: '#112233', image: new Blob([new Uint8Array(8)], { type: 'image/png' }), devBuyLamports: 100_000_000n },
      keypairSigner(launcherKp, 'Phantom'),
      (p) => phases.push(p),
    );
    expect(out.ok).toBe(true);
    const order = [...new Set(phases.map((p) => p.phase))];
    expect(order).toEqual(['preparing', 'awaiting-signature', 'sending', 'confirming', 'registering', 'done']);
    expect(phases.find((p) => p.phase === 'awaiting-signature')?.walletName).toBe('Phantom');
    // The tx on the wire: same message the Worker co-signed, 3 non-empty signatures, ≤ 1,232 B.
    expect(sentTx).not.toBeNull();
    const tx = sentTx!;
    expect(Buffer.from(tx.message.serialize()).equals(Buffer.from(cosigned!))).toBe(true);
    expect(tx.signatures.length).toBe(3);
    expect(tx.signatures.every((s) => s.some((b) => b !== 0))).toBe(true);
    expect(tx.serialize().length).toBeLessThanOrEqual(TX_SIZE_LIMIT);
    // Each signature verifies (WebCrypto Ed25519) — wallet, mint and attestor.
    const msgBytes = tx.message.serialize();
    for (let i = 0; i < 3; i++) {
      const key = await crypto.subtle.importKey('raw', tx.message.staticAccountKeys[i].toBytes() as BufferSource, { name: 'Ed25519' }, false, ['verify']);
      expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, tx.signatures[i] as BufferSource, msgBytes as BufferSource)).toBe(true);
    }
    if (out.ok) {
      expect(out.value.devBuy?.estimated).toBe(true); // getTransaction returned null → quote-based estimate
      expect(out.explorerUrl).toContain('?cluster=devnet');
    }
    // RPC budget: no more than a dozen HTTP requests for the whole launch (incl. rent + globals warm-up).
    expect(rpc.httpRequests()).toBeLessThanOrEqual(12);
    void bytesToB64;
  }, 30_000);
});
