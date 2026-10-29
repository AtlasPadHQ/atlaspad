/**
 * Launch (INTEGRATION.md §4.4, SPEC §8.1/§8.4): metadata → mint keypair → prepare → build the v0 message through the
 * frozen CORNERSHOP ALT in EXACTLY the order `checkLaunchMessage` requires → Worker co-sign → mint signs → simulate →
 * wallet signs → send/confirm → `/api/launch/confirm` → dev-buy fill. Heavy module.
 *
 *   0 ComputeBudget.setComputeUnitLimit      3 shop_vault.register_launch(place_hash)   (attestor = read-only signer)
 *   1 ComputeBudget.setComputeUnitPrice      4 ATA.CreateIdempotent(launcher, mint, Token-2022)   } only with a
 *   2 pump.create_v2(creator = vault)        5 pump.buy_exact_quote_in_v3(spend, min 1)          } dev buy
 */
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type MessageV0,
} from '@solana/web3.js';
import * as sv from '@cornershop/shop-vault-client';
import { Buffer } from 'buffer';
import type { CoinDTO, LaunchPrepareResponse } from '../../worker/wire';
import { CLUSTER } from '../mode';
import {
  ALT_KEYS,
  ATA_PROGRAM,
  BUYBACK_FEE_RECIPIENT,
  CU,
  LAMPORTS_PER_SIGNATURE,
  LAUNCH_ACCOUNT_SIZES,
  NAME_MAX_BYTES,
  PUMP_PROGRAM,
  SHOP_VAULT_PROGRAM,
  SYMBOL_MAX_BYTES,
  SYSTEM_PROGRAM,
  TOKEN_2022,
  TX_SIZE_LIMIT,
} from './constants';
import { assertCanSign, backend, chainConfig, loadPump } from './context';
import { lamportsPerToken } from './curve';
import { ApiError, toTxError, TxFail } from './errors';
import { fillFromTx } from './events';
import { explorerTx } from './explorer';
import { pumpGlobals, rentFor } from './market';
import type { PumpOps } from './pumpOps';
import { b64ToBytes, bytesToB64, getMultipleAccountsRaw, rpc } from './rpc';
import { executeWithRetry, fetchTx, latestBlockhash, simulate } from './send';
import type { LaunchCostEstimate, LaunchInput, LaunchValue, OnProgress, TradeFill, TxOutcome, WalletSigner } from './types';

const utf8Len = (s: string) => new TextEncoder().encode(s).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T22 = new PublicKey(TOKEN_2022);

/* ------------------------------------------------------------------------------------------ building blocks */

/** ATA program `CreateIdempotent` (data [1]); account order as `checkLaunchMessage` expects. Hand-built: no spl-token. */
export function createAtaIdempotentIx(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ATA_PROGRAM),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SYSTEM_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export interface LaunchIxParams {
  launcher: PublicKey;
  mint: PublicKey;
  attestor: PublicKey;
  placeHash: Uint8Array;
  vault: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  devBuyLamports: bigint;
  computeUnitLimit: number;
  priorityFeeMicroLamports: number;
}

/** The launch instructions in policy order (exported for tests and the devnet e2e). */
export async function launchInstructions(ops: PumpOps, p: LaunchIxParams): Promise<TransactionInstruction[]> {
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: p.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.priorityFeeMicroLamports }),
    await ops.createV2Ix({ mint: p.mint, name: p.name, symbol: p.symbol, uri: p.uri, creator: p.vault, user: p.launcher }),
    sv.registerLaunch({ launcher: p.launcher, attestor: p.attestor, placeHash: p.placeHash, mint: p.mint }),
  ];
  if (p.devBuyLamports > 0n) {
    ixs.push(
      createAtaIdempotentIx(p.launcher, sv.associatedTokenAddress(p.launcher, p.mint, T22), p.launcher, p.mint, T22),
      await ops.devBuyIx({ user: p.launcher, mint: p.mint, spendableLamports: p.devBuyLamports, buybackFeeRecipient: new PublicKey(BUYBACK_FEE_RECIPIENT) }),
    );
  }
  return ixs;
}

/** Compile the v0 launch message through the ALT and assert the co-signed size fits (≤ 1,232 B with 3 signatures). */
export function compileLaunchMessage(ixs: TransactionInstruction[], launcher: PublicKey, blockhash: string, alt: AddressLookupTableAccount): MessageV0 {
  const msg = new TransactionMessage({ payerKey: launcher, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message([alt]);
  const size = new VersionedTransaction(msg).serialize().length;
  if (size > TX_SIZE_LIMIT) {
    throw new TxFail('unknown', { message: "This coin's details are too long to fit in one Solana transaction. Shorten the name and try again.", retryable: false });
  }
  return msg;
}

const altCache = new Map<string, AddressLookupTableAccount>();

/** The frozen CORNERSHOP ALT, verified (exactly ALT_KEYS, no authority). Cached for the session. */
export async function getLaunchAlt(address: string): Promise<AddressLookupTableAccount> {
  const hit = altCache.get(address);
  if (hit) return hit;
  const r = await rpc<{ value: { data: [string, string]; owner: string } | null }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!r.value) throw new TxFail('network', { message: "We couldn't load the launch settings from Solana. Try again." });
  const state = AddressLookupTableAccount.deserialize(b64ToBytes(r.value.data[0]));
  const keys = state.addresses.map((k) => k.toBase58());
  const exact = keys.length === ALT_KEYS.length && keys.every((k, i) => k === ALT_KEYS[i]);
  if (!exact || state.authority !== undefined) {
    throw new TxFail('wrong-network', { message: 'The launch settings on this network look wrong. Reload and try again.' });
  }
  const alt = new AddressLookupTableAccount({ key: new PublicKey(address), state });
  altCache.set(address, alt);
  return alt;
}

/* ------------------------------------------------------------------------------------------ cost estimate */

/**
 * Network fee + rent + dev buy for the Review step (INTEGRATION.md §7.2, §9: never below the true cost, ±0.0005 SOL).
 * Rent is read from the cluster for the exact account sizes a launch creates (constants.LAUNCH_ACCOUNT_SIZES). The mint
 * size grows with name/symbol/uri: unknown ones are assumed at their maximum (32 / 10 bytes); the URI length is known
 * from `config.publicOrigin` (`<origin>/meta/<32 hex>.json`).
 */
export async function estimateLaunchCost(
  devBuyLamports: bigint,
  meta: { name?: string; symbol?: string; uri?: string; launcher?: string } = {},
): Promise<LaunchCostEstimate> {
  const cfg = chainConfig();
  const nameLen = meta.name ? Math.min(utf8Len(meta.name), NAME_MAX_BYTES) : NAME_MAX_BYTES;
  const symLen = meta.symbol ? Math.min(utf8Len(meta.symbol), SYMBOL_MAX_BYTES) : SYMBOL_MAX_BYTES;
  const uriLen = meta.uri ? utf8Len(meta.uri) : utf8Len(`${cfg.publicOrigin}/meta/${'0'.repeat(32)}.json`);
  const s = LAUNCH_ACCOUNT_SIZES;
  const sizes = [s.mintBase + nameLen + symLen + uriLen, s.bondingCurve, s.token2022Ata, s.vaultState, s.vault];
  if (devBuyLamports > 0n) {
    sizes.push(s.token2022Ata); // the launcher's ATA for a brand-new mint never exists yet
    // pump creates the launcher's UserVolumeAccumulator on its first buy; unknown launcher → assume it (never low).
    let needsAccumulator = true;
    if (meta.launcher) {
      const [acc] = await getMultipleAccountsRaw([userVolumeAccumulatorPda(new PublicKey(meta.launcher)).toBase58()]).catch(() => [null]);
      needsAccumulator = !acc;
    }
    if (needsAccumulator) sizes.push(s.userVolumeAccumulator);
  }
  const rents = await rentFor(sizes);
  const rentLamports = sizes.reduce((sum, size) => sum + rents.get(size)!, 0n);
  const priority = (BigInt(CU.launch) * BigInt(cfg.priorityFeeMicroLamports) + 999_999n) / 1_000_000n;
  const feeLamports = 3n * LAMPORTS_PER_SIGNATURE + priority;
  const out: LaunchCostEstimate = { rentLamports, feeLamports, devBuyLamports, totalLamports: rentLamports + feeLamports + devBuyLamports };
  if (devBuyLamports > 0n) {
    try {
      const ops = await loadPump();
      const { global, feeConfig } = await pumpGlobals();
      out.devBuyTokensEstimate = ops.quoteFreshCurveBuy(global, feeConfig, devBuyLamports, new PublicKey(SHOP_VAULT_PROGRAM));
    } catch {
      /* display-only extra */
    }
  }
  return out;
}

/** pump's per-user volume accumulator PDA (created by the program on a wallet's first buy). */
export function userVolumeAccumulatorPda(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'), user.toBuffer()], new PublicKey(PUMP_PROGRAM))[0];
}

/* ------------------------------------------------------------------------------------------ the flow */

/** Sanity-check the Worker's prepare answer against our config and our own derivations before signing anything. */
function checkPrepare(prep: LaunchPrepareResponse, mint: PublicKey): { placeHash: Uint8Array; vault: PublicKey; attestor: PublicKey } {
  const cfg = chainConfig();
  const placeHash = sv.fromHex(prep.placeHash);
  const ok =
    prep.programId === SHOP_VAULT_PROGRAM &&
    prep.attestor === cfg.attestor &&
    prep.alt === cfg.alt &&
    sv.toHex(sv.placeHash(prep.placeId)) === prep.placeHash &&
    sv.vaultPda(placeHash)[0].toBase58() === prep.vault &&
    sv.vaultStatePda(placeHash)[0].toBase58() === prep.vaultState &&
    mint instanceof PublicKey;
  if (!ok) throw new TxFail('wrong-network', { message: "We couldn't prepare this launch. Reload and try again." });
  return { placeHash, vault: new PublicKey(prep.vault), attestor: new PublicKey(prep.attestor) };
}

async function confirmLaunch(reservationId: string, signature: string): Promise<CoinDTO> {
  const deadline = Date.now() + 30_000;
  let tries = 0;
  for (;;) {
    try {
      const r = await backend().launchConfirm({ reservationId, signature });
      if (r.status === 'registered') return r.coin;
    } catch (e) {
      // 422 not_confirmed etc. are final; network blips and 5xx retry until the deadline.
      if (!(e instanceof ApiError) || (e.status > 0 && e.status < 500 && e.status !== 429)) throw e;
    }
    if (Date.now() > deadline) {
      throw new TxFail('unconfirmed', {
        sent: true,
        signature,
        message: "Your coin is on Solana, but it's taking a moment to show on the map. Check back in a minute.",
      });
    }
    // the Worker's getTransaction can trail our confirmed status by a slot: retry quickly first
    await sleep(tries++ < 3 ? 500 : 1500);
  }
}

/** INTEGRATION.md §4.2 `launchCoin`. Never throws for expected failures. */
export async function launchCoin(input: LaunchInput, signer: WalletSigner, onProgress: OnProgress): Promise<TxOutcome<LaunchValue>> {
  let sent = false;
  let signature: string | undefined;
  const progress: OnProgress = (p) => {
    if (p.phase === 'preparing' || p.phase === 'awaiting-signature') {
      sent = false;
      signature = undefined;
    }
    if (p.signature) {
      sent = true;
      signature = p.signature;
    }
    onProgress(p);
  };
  let violations: string[] | undefined;
  try {
    const cfg = assertCanSign('Launching');
    if (input.devBuyLamports < 0n || input.devBuyLamports > BigInt(cfg.maxDevBuyLamports)) {
      throw new TxFail('unknown', { message: 'That first buy is too big. Pick a smaller amount.', retryable: false });
    }
    const launcher = new PublicKey(signer.address);
    const opsP = loadPump(); // in parallel with the uploads

    progress({ phase: 'preparing', step: 'metadata' });
    const meta = await backend().uploadMetadata({
      name: input.name,
      symbol: input.ticker,
      description: input.description,
      placeId: input.placeId,
      image: input.image,
    });

    const prepare = async (mintKp: Keypair) => {
      progress({ phase: 'preparing', step: 'prepare' });
      const prep = await backend().launchPrepare({
        placeId: input.placeId,
        launcher: launcher.toBase58(),
        mint: mintKp.publicKey.toBase58(),
        metadataId: meta.metadataId,
        category: input.category,
        emoji: input.emoji,
        bg: input.bg,
        devBuyLamports: input.devBuyLamports.toString(),
      });
      return { prep, mintKp, ...checkPrepare(prep, mintKp.publicKey) };
    };

    let cur = await prepare(Keypair.generate());
    const [ops, alt] = await Promise.all([opsP, getLaunchAlt(cur.prep.alt)]);
    const estimate = await estimateLaunchCost(input.devBuyLamports, { name: cur.prep.name, symbol: cur.prep.symbol, uri: cur.prep.uri, launcher: signer.address }).catch(
      () => null,
    );
    let cosigns = 0;
    /** The Worker's per-place lock deadline (fixed at the first co-sign; re-co-signing never extends it). */
    let lockedUntil = 0;

    const landed = await executeWithRetry(
      async (attempt) => {
        if (attempt > 1) {
          // Blockhash expired: re-cosign the same reservation while it and its lock are valid (≤ 5 co-signs), else a
          // new prepare + mint (the Worker replaces this launcher's own earlier lock).
          if (Date.now() < cur.prep.expiresAt - 10_000 && cosigns < 5 && (lockedUntil === 0 || Date.now() < lockedUntil - 10_000)) {
            const bh = await latestBlockhash();
            cur = { ...cur, prep: { ...cur.prep, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight } };
          } else {
            cur = await prepare(Keypair.generate());
            cosigns = 0;
            lockedUntil = 0;
          }
        }
        const { prep, mintKp } = cur;
        progress({ phase: 'preparing', step: 'build' });
        const ixs = await launchInstructions(ops, {
          launcher,
          mint: mintKp.publicKey,
          attestor: cur.attestor,
          placeHash: cur.placeHash,
          vault: cur.vault,
          name: prep.name,
          symbol: prep.symbol,
          uri: prep.uri,
          devBuyLamports: input.devBuyLamports,
          computeUnitLimit: prep.computeUnitLimit,
          priorityFeeMicroLamports: prep.priorityFeeMicroLamports,
        });
        const msg = compileLaunchMessage(ixs, launcher, prep.blockhash, alt);
        progress({ phase: 'preparing', step: 'cosign' });
        let co;
        try {
          co = await backend().launchCosign({ reservationId: prep.reservationId, messageBase64: bytesToB64(msg.serialize()) });
        } catch (e) {
          if (e instanceof ApiError && e.body?.violations) violations = e.body.violations;
          throw e;
        }
        cosigns++;
        if (typeof co.lockedUntil === 'number' && co.lockedUntil > 0) lockedUntil = co.lockedUntil;
        if (co.attestor !== prep.attestor) throw new TxFail('policy');
        const tx = new VersionedTransaction(msg);
        tx.addSignature(cur.attestor, b64ToBytes(co.attestorSignature));
        tx.sign([mintKp]);
        progress({ phase: 'preparing', step: 'simulate' });
        await simulate(tx, { needLamports: estimate?.totalLamports });
        return { tx, lastValidBlockHeight: prep.lastValidBlockHeight };
      },
      signer,
      progress,
    );

    progress({ phase: 'registering', walletName: signer.walletName, signature: landed.signature, explorerUrl: explorerTx(landed.signature) });
    // registration and the dev-buy fill read in parallel (the success screen waits for both; speed budget §8)
    const [coin, devTx] = await Promise.all([
      confirmLaunch(cur.prep.reservationId, landed.signature),
      input.devBuyLamports > 0n ? fetchTx(landed.signature) : Promise.resolve(null),
    ]);

    let devBuy: TradeFill | null = null;
    if (input.devBuyLamports > 0n) {
      const tx = devTx;
      devBuy = tx ? fillFromTx(tx, { mint: cur.mintKp.publicKey.toBase58(), user: launcher.toBase58(), side: 'buy' }) : null;
      if (!devBuy && estimate?.devBuyTokensEstimate) {
        const t = estimate.devBuyTokensEstimate;
        devBuy = { side: 'buy', lamports: input.devBuyLamports, tokens: t, priceLamportsPerToken: lamportsPerToken(input.devBuyLamports, t), estimated: true };
      }
    }
    const explorerUrl = explorerTx(landed.signature);
    progress({ phase: 'done', walletName: signer.walletName, signature: landed.signature, explorerUrl });
    return { ok: true, signature: landed.signature, explorerUrl, value: { coin, mint: cur.mintKp.publicKey.toBase58(), devBuy } };
  } catch (e) {
    const error = toTxError(e, { sent, signature, walletName: signer.walletName });
    if (error.code === 'policy' && violations && CLUSTER === 'devnet') console.warn('[cornershop] launch co-sign refused:', violations);
    return { ok: false, error };
  }
}
