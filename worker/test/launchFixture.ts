/**
 * Test fixtures: launch / claim messages built EXACTLY like the browser does (INTEGRATION §4.4) with the pinned
 * @pump-fun/pump-sdk 3.2.0 builders, web3.js 1.99 and the shop-vault client, so the policy is tested against real
 * SDK output. CJS loading via createRequire (pump-sdk's ESM build does not load under plain Node).
 */
import { createRequire } from 'node:module';
import { launchAddresses } from '../addresses';
import { ALT_KEYS, POLICY_MAX_CU_CLAIM, POLICY_MAX_CU_LAUNCH, POLICY_MAX_CU_PRICE, SHOP_VAULT_PROGRAM_ID } from '../consts';
import type { ClaimExpect, LaunchExpect } from '../policy';

const require = createRequire(import.meta.url);
export const web3 = require('@solana/web3.js');
export const pump = require('@pump-fun/pump-sdk');
export const BN = require('bn.js');
export const NodeBuffer = require('buffer').Buffer;
const sdk = new pump.PumpSdk();

type Pk = any;
type Kp = any;
type TxIx = any;

let svMod: any = null;
/** The shop-vault client (ESM). */
export async function sv(): Promise<any> {
  svMod ??= await import('@cornershop/shop-vault-client');
  return svMod;
}

export const BLOCKHASH = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
export const BUYBACK = new web3.PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');

export function altAccount(address: string = altAddress(), keys: readonly string[] = ALT_KEYS): any {
  return new web3.AddressLookupTableAccount({
    key: new web3.PublicKey(address),
    state: {
      deactivationSlot: 0xffff_ffff_ffff_ffffn,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: keys.map((k) => new web3.PublicKey(k)),
    },
  });
}

let fixedAlt: string | null = null;
export function altAddress(): string {
  fixedAlt ??= web3.Keypair.generate().publicKey.toBase58();
  return fixedAlt!;
}

export interface LaunchOpts {
  devBuy?: bigint;
  placeId?: string;
  name?: string;
  symbol?: string;
  uri?: string;
  creator?: Pk;
  mayhem?: boolean;
  cuLimit?: number;
  cuPrice?: number;
  noComputeBudget?: boolean;
  /** Change the instruction list before compiling. */
  mutate?: (ixs: TxIx[], ctx: LaunchKeys) => TxIx[] | void;
  payer?: Pk;
  alts?: any[];
}

export interface LaunchKeys {
  launcher: Kp;
  mint: Kp;
  attestor: Kp;
  placeId: string;
  placeHash: Uint8Array;
  vault: Pk;
  name: string;
  symbol: string;
  uri: string;
}

export interface BuiltLaunch extends LaunchKeys {
  ixs: TxIx[];
  message: any;
  bytes: Uint8Array;
  expect: LaunchExpect;
}

export const DEFAULT_META = {
  name: 'Corner Cafe Ltd',
  symbol: 'CAFE',
  uri: 'https://cornershop-devnet.tiejiucai.workers.dev/meta/0123456789abcdef0123456789abcdef.json',
};

export async function keysFor(placeId = 'ChIJN1t_tDeuEmsRUsoyG83frY4', meta = DEFAULT_META): Promise<LaunchKeys> {
  const s = await sv();
  const placeHash: Uint8Array = s.placeHash(placeId);
  return {
    launcher: web3.Keypair.generate(),
    mint: web3.Keypair.generate(),
    attestor: web3.Keypair.generate(),
    placeId,
    placeHash,
    vault: s.vaultPda(placeHash)[0],
    ...meta,
  };
}

export async function launchIxs(k: LaunchKeys, o: LaunchOpts = {}): Promise<TxIx[]> {
  const s = await sv();
  const devBuy = o.devBuy ?? 100_000_000n;
  const ixs: TxIx[] = [];
  if (!o.noComputeBudget) {
    ixs.push(web3.ComputeBudgetProgram.setComputeUnitLimit({ units: o.cuLimit ?? 400_000 }));
    ixs.push(web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: o.cuPrice ?? 10_000 }));
  }
  ixs.push(
    await sdk.createV2Instruction({
      mint: k.mint.publicKey,
      name: o.name ?? k.name,
      symbol: o.symbol ?? k.symbol,
      uri: o.uri ?? k.uri,
      creator: o.creator ?? k.vault,
      user: k.launcher.publicKey,
      mayhemMode: !!o.mayhem,
    }),
  );
  ixs.push(s.registerLaunch({ launcher: k.launcher.publicKey, attestor: k.attestor.publicKey, placeHash: k.placeHash, mint: k.mint.publicKey }));
  if (devBuy > 0n) {
    ixs.push(
      new web3.TransactionInstruction({
        programId: s.ASSOCIATED_TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: k.launcher.publicKey, isSigner: true, isWritable: true },
          { pubkey: s.associatedTokenAddress(k.launcher.publicKey, k.mint.publicKey, s.TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
          { pubkey: k.launcher.publicKey, isSigner: false, isWritable: false },
          { pubkey: k.mint.publicKey, isSigner: false, isWritable: false },
          { pubkey: s.SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: s.TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: NodeBuffer.from([1]),
      }),
    );
    ixs.push(
      await sdk.getBuyExactQuoteInV3InstructionRaw({
        user: k.launcher.publicKey,
        mint: k.mint.publicKey,
        spendableQuoteIn: new BN(devBuy.toString()),
        minTokensOut: new BN(1),
        buybackFeeRecipient: BUYBACK,
      }),
    );
  }
  return ixs;
}

export function compile(payer: Pk, ixs: TxIx[], alts: any[] = [altAccount()]): any {
  return new web3.TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message(alts);
}

export async function expectFor(k: LaunchKeys, devBuy: bigint, over: Partial<LaunchExpect> = {}): Promise<LaunchExpect> {
  const a = await launchAddresses(k.placeHash, k.launcher.publicKey.toBase58(), k.mint.publicKey.toBase58(), SHOP_VAULT_PROGRAM_ID);
  return {
    programId: SHOP_VAULT_PROGRAM_ID,
    attestor: k.attestor.publicKey.toBase58(),
    launcher: k.launcher.publicKey.toBase58(),
    mint: k.mint.publicKey.toBase58(),
    placeHash: a.placeHash,
    vault: a.vault,
    vaultState: a.vaultState,
    config: a.config,
    bondingCurve: a.bondingCurve,
    curveBaseAta: a.curveBaseAta,
    curveQuoteAta: a.curveQuoteAta,
    mayhemState: a.mayhemState,
    mayhemTokenVault: a.mayhemTokenVault,
    launcherAta: a.launcherAta,
    launcherWsolAta: a.launcherWsolAta,
    userVolumeAccumulator: a.userVolumeAccumulator,
    name: k.name,
    symbol: k.symbol,
    uri: k.uri,
    devBuyLamports: devBuy,
    maxDevBuyLamports: 1_000_000_000n,
    alt: { address: altAddress(), keys: ALT_KEYS },
    maxComputeUnitLimit: POLICY_MAX_CU_LAUNCH,
    maxComputeUnitPriceMicroLamports: POLICY_MAX_CU_PRICE,
    ...over,
  };
}

export async function buildLaunch(o: LaunchOpts = {}, keys?: LaunchKeys): Promise<BuiltLaunch> {
  const k = keys ?? (await keysFor(o.placeId));
  let ixs = await launchIxs(k, o);
  if (o.mutate) ixs = o.mutate(ixs, k) ?? ixs;
  const message = compile(o.payer ?? k.launcher.publicKey, ixs, o.alts ?? [altAccount()]);
  const bytes = new Uint8Array(message.serialize());
  return { ...k, ixs, message, bytes, expect: await expectFor(k, o.devBuy ?? 100_000_000n) };
}

/* ----------------------------------------------------------------------------------------------- claims */

export interface BuiltClaim {
  attestor: Kp;
  newOwner: Kp;
  placeId: string;
  bytes: Uint8Array;
  expect: ClaimExpect;
}

export async function buildClaim(
  o: { nonce?: bigint; expectedNonce?: bigint; placeId?: string; mutate?: (ixs: TxIx[], k: { attestor: Kp; newOwner: Kp }) => TxIx[] | void; payer?: Pk } = {},
): Promise<BuiltClaim> {
  const s = await sv();
  const placeId = o.placeId ?? 'ChIJN1t_tDeuEmsRUsoyG83frY4';
  const attestor = web3.Keypair.generate();
  const newOwner = web3.Keypair.generate();
  const ph = s.placeHash(placeId);
  let ixs: TxIx[] = [
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }),
    web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    s.requestClaim({ attestor: attestor.publicKey, newOwner: newOwner.publicKey, placeHash: ph, nonce: o.nonce ?? 1n }),
  ];
  if (o.mutate) ixs = o.mutate(ixs, { attestor, newOwner }) ?? ixs;
  const msg = new web3.TransactionMessage({ payerKey: o.payer ?? newOwner.publicKey, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message([]);
  const ph2 = s.placeHash(placeId);
  return {
    attestor,
    newOwner,
    placeId,
    bytes: new Uint8Array(msg.serialize()),
    expect: {
      programId: SHOP_VAULT_PROGRAM_ID,
      attestor: attestor.publicKey.toBase58(),
      newOwner: newOwner.publicKey.toBase58(),
      config: s.configPda()[0].toBase58(),
      vaultState: s.vaultStatePda(ph2)[0].toBase58(),
      expectedNonce: o.expectedNonce ?? 1n,
      maxComputeUnitLimit: POLICY_MAX_CU_CLAIM,
      maxComputeUnitPriceMicroLamports: POLICY_MAX_CU_PRICE,
    },
  };
}

/** Seeded PRNG (mulberry32) for reproducible fuzzing. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
