/**
 * Shop vault reads, claims and withdrawals (INTEGRATION.md §4.6, SPEC §5.3–§5.7, §8.2, §8.3). Heavy module.
 *
 *  getVault            ONE getMultipleAccounts([vault_state, vault, pump creator_vault(vault), bonding curve,
 *                      vault WSOL ATA, pump-amm creator WSOL vault]) → exact lamports (shop-vault client feesWaiting)
 *  requestClaim        [CU limit, CU price, request_claim(nonce = claim_nonce + 1)] → Worker co-sign → wallet → confirm
 *  finalizeClaim       permissionless once now ≥ unlock_ts
 *  collectAndWithdraw  [sweep_creator_fee][pump-amm transfer][collect_creator_fee][unwrap_wsol] withdraw — one tx
 *
 * Compute limits and priority come from ./budget: sized per instruction, priority capped (these txs race nobody).
 */
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import * as sv from '@cornershop/shop-vault-client';
import { Buffer } from 'buffer';
import type { ClaimConfirmResponse } from '../../worker/wire';
import { priorityLamports, VAULT_CU, vaultPriorityMicroLamports, withdrawCuLimit, type WithdrawSteps } from './budget';
import { LAMPORTS_PER_SIGNATURE, PUMP_AMM_PROGRAM, PUMP_EVENT_AUTHORITY, PUMP_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM, TX_SIZE_LIMIT, WSOL_MINT } from './constants';
import { assertCanSign, backend, chainConfig, loadPump } from './context';
import { ApiError, toTxError, TxFail } from './errors';
import { decodePumpPool } from './curve';
import { lamportDelta, withdrawnAmount, type TxJson } from './events';
import { explorerTx } from './explorer';
import { rentFor } from './market';
import { b64ToBytes, bytesToB64, getMultipleAccountsRaw, type RawAccount } from './rpc';
import { executeWithRetry, fetchTx, latestBlockhash, simulate, type Built } from './send';
import type { ClaimRequestValue, OnProgress, TxOutcome, VaultView, WalletSigner, WithdrawValue } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** `sha256("global:collect_creator_fee")[..8]` (pump IDL 3.2.0; same bytes the shop-vault e2e uses). */
const COLLECT_CREATOR_FEE_DISC = Uint8Array.from([0x14, 0x16, 0x56, 0x7b, 0xc6, 0x1c, 0xdb, 0x84]);
const SPL_ACCOUNT_LEN = 165;

type AmmModule = typeof import('./amm');
let ammP: Promise<AmmModule> | null = null;
const loadAmm = () => (ammP ??= import('./amm').catch((e: unknown) => ((ammP = null), Promise.reject(e))));

/** pump `collect_creator_fee(creator)`: permissionless, pays pump's creator_vault(creator) above rent to `creator`. */
export function collectCreatorFeeIx(creator: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(PUMP_PROGRAM),
    keys: [
      { pubkey: creator, isSigner: false, isWritable: true },
      { pubkey: sv.pumpCreatorVaultPda(creator), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(SYSTEM_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(PUMP_EVENT_AUTHORITY), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(PUMP_PROGRAM), isSigner: false, isWritable: false },
    ],
    data: Buffer.from(COLLECT_CREATOR_FEE_DISC),
  });
}

/**
 * pump-amm's coin-creator WSOL vault of `creator` (graduated creator fees): ATA(PDA(["creator_vault", creator],
 * pump-amm), WSOL, SPL Token). Derived here so `getVault` never loads the AMM chunk (vault.test.ts checks it against
 * pump-swap-sdk `coinCreatorVaultAtaPda(coinCreatorVaultAuthorityPda(creator), …)`).
 */
export function ammCreatorVaultAta(creator: PublicKey): PublicKey {
  const [authority] = PublicKey.findProgramAddressSync([Buffer.from('creator_vault'), creator.toBuffer()], new PublicKey(PUMP_AMM_PROGRAM));
  return sv.associatedTokenAddress(authority, new PublicKey(WSOL_MINT), new PublicKey(TOKEN_PROGRAM));
}

/** The canonical PumpSwap pool of a pump coin: PDA(["pool", u16le(0), PDA(["pool-authority", mint], pump), mint, WSOL], pump-amm). */
export function canonicalPoolPda(mint: PublicKey): PublicKey {
  const [authority] = PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), mint.toBuffer()], new PublicKey(PUMP_PROGRAM));
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), Buffer.from([0, 0]), authority.toBuffer(), mint.toBuffer(), new PublicKey(WSOL_MINT).toBuffer()],
    new PublicKey(PUMP_AMM_PROGRAM),
  )[0];
}

/* ------------------------------------------------------------------------------------------ reads */

interface VaultRead {
  view: VaultView;
  placeHash: Uint8Array;
  vault: PublicKey;
  /** Raw pieces for the withdraw builder. */
  curveBucket: bigint;
  pumpCreatorVaultLamports: bigint;
  wsolAccount: RawAccount | null;
  ammVaultAmount: bigint;
  /** Canonical pool's `creatorFees` bucket owed to this vault (graduated coins, v2 trades). */
  poolCreatorFees: bigint;
  graduated: boolean;
  mint: PublicKey | null;
  /** The optional steps a withdraw built now would carry (sizes its CU limit and the cost estimate). */
  plan: WithdrawSteps;
}

/** The optional steps of the owner's collect + withdraw tx (SPEC §8.3): only the ones that move something. */
export function withdrawPlan(
  v: Pick<VaultRead, 'curveBucket' | 'pumpCreatorVaultLamports' | 'wsolAccount' | 'ammVaultAmount' | 'poolCreatorFees' | 'graduated' | 'mint'>,
  rent0: bigint,
): WithdrawSteps {
  const curveSweep = v.curveBucket > 0n && !!v.mint;
  const ammTransfer = v.graduated && (v.ammVaultAmount > 0n || v.poolCreatorFees > 0n);
  return {
    curveSweep,
    poolSweep: v.graduated && v.poolCreatorFees > 0n && !!v.mint,
    ammTransfer,
    collect: v.pumpCreatorVaultLamports > rent0 || curveSweep || ammTransfer,
    unwrap: !!v.wsolAccount,
  };
}

function splAmount(a: RawAccount | null): bigint {
  return a && a.data.length >= 72 ? new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) : 0n;
}

async function readVault(placeId: string, mintHint?: string): Promise<VaultRead> {
  const { placeHash, vault, vaultState } = sv.placeAddresses(placeId);
  const ammAta = ammCreatorVaultAta(vault).toBase58();
  const base = [vaultState.toBase58(), vault.toBase58(), sv.pumpCreatorVaultPda(vault).toBase58(), sv.vaultWsolAta(vault).toBase58()];
  const curveKey = mintHint ? sv.bondingCurvePda(new PublicKey(mintHint)).toBase58() : null;
  const poolKey = mintHint ? canonicalPoolPda(new PublicKey(mintHint)).toBase58() : null;
  const keys = [...base, ...(curveKey ? [curveKey, poolKey!] : []), ammAta];
  const [accs, rents] = await Promise.all([getMultipleAccountsRaw(keys), rentFor([0, sv.VAULT_STATE_LEN, SPL_ACCOUNT_LEN])]);
  const [stateAcc, vaultAcc, creatorVaultAcc, wsolAcc] = accs;
  let curveAcc = curveKey ? accs[4] : null;
  let poolAcc = poolKey ? accs[5] : null;
  const ammAcc = accs[keys.length - 1];

  const st = stateAcc && stateAcc.data.length === sv.VAULT_STATE_LEN ? sv.decodeVaultState(stateAcc.data) : null;
  const mint = st ? st.mint : mintHint ? new PublicKey(mintHint) : null;
  if (st && (!curveKey || st.mint.toBase58() !== mintHint)) {
    // Second (rare) round trip: the registry's mint was missing or stale.
    [curveAcc, poolAcc] = await getMultipleAccountsRaw([sv.bondingCurvePda(st.mint).toBase58(), canonicalPoolPda(st.mint).toBase58()]);
  }
  let curveBucket = 0n;
  let graduated = false;
  if (curveAcc && curveAcc.data.length >= 125) {
    const c = sv.decodeBondingCurvePrefix(curveAcc.data);
    curveBucket = c.creatorFeeBucket;
    graduated = c.complete;
  }
  const rent0 = rents.get(0)!;
  const rentState = rents.get(sv.VAULT_STATE_LEN)!;
  const wsolOk = !!wsolAcc && wsolAcc.data.length === SPL_ACCOUNT_LEN;
  const ammVaultAmount = splAmount(ammAcc);
  let poolCreatorFees = 0n;
  if (graduated && poolAcc && poolAcc.owner === PUMP_AMM_PROGRAM) {
    try {
      const pool = decodePumpPool(poolAcc.data);
      if (pool.coinCreator === vault.toBase58()) poolCreatorFees = pool.creatorFees;
    } catch {
      /* pre-upgrade pool layout: no bucket */
    }
  }
  const fees = sv.feesWaiting({
    vaultLamports: vaultAcc?.lamports ?? 0n,
    vaultStateLamports: stateAcc?.lamports ?? 0n,
    rentMin0: rent0,
    rentMinVaultState: rentState,
    pumpCreatorVaultLamports: creatorVaultAcc?.lamports ?? 0n,
    curveCreatorFeeBucket: curveBucket,
    wsolLamports: wsolOk ? wsolAcc!.lamports : 0n,
  });
  const collectable = fees.collectable + ammVaultAmount + poolCreatorFees;
  const pumpCreatorVaultLamports = creatorVaultAcc?.lamports ?? 0n;
  const plan = withdrawPlan({ curveBucket, pumpCreatorVaultLamports, wsolAccount: wsolOk ? wsolAcc : null, ammVaultAmount, poolCreatorFees, graduated, mint }, rent0);
  // One-time rents the owner's withdraw pays: the first curve sweep creates pump's creator_vault(vault) (rent_min(0));
  // a pool sweep creates the coin creator's WSOL vault on pump-amm when it is missing (an SPL account, SDK docs).
  const creatorVaultMissing = !creatorVaultAcc || creatorVaultAcc.lamports === 0n;
  const ammAtaMissing = !ammAcc || ammAcc.lamports === 0n;
  const oneTimeRent = (plan.curveSweep && creatorVaultMissing ? rent0 : 0n) + (plan.poolSweep && ammAtaMissing ? rents.get(SPL_ACCOUNT_LEN)! : 0n);
  const cuLimit = withdrawCuLimit(plan);
  const priority = priorityLamports(cuLimit, vaultPriorityMicroLamports(cuLimit, chainConfig().priorityFeeMicroLamports));
  const withdrawCostLamports = LAMPORTS_PER_SIGNATURE + priority + oneTimeRent;
  const view: VaultView = {
    placeId,
    placeHash: sv.toHex(placeHash),
    vault: vault.toBase58(),
    vaultState: vaultState.toBase58(),
    exists: !!st,
    mint: mint ? mint.toBase58() : null,
    launcher: st ? st.launcher.toBase58() : null,
    owner: st?.owner ? st.owner.toBase58() : null,
    pendingOwner: st?.pending ? st.pending.owner.toBase58() : null,
    unlockTs: st?.pending ? Number(st.pending.unlockTs) : null,
    inProbation: !!st?.pending?.inProbation,
    claimNonce: st ? st.claimNonce : 0n,
    totalWithdrawn: st ? st.totalWithdrawn : 0n,
    fees: { withdrawableNow: fees.withdrawableNow, collectable, total: fees.withdrawableNow + collectable },
    withdrawCostLamports,
    at: Date.now(),
  };
  return {
    view,
    placeHash,
    vault,
    curveBucket,
    pumpCreatorVaultLamports,
    wsolAccount: wsolOk ? wsolAcc : null,
    ammVaultAmount,
    poolCreatorFees,
    graduated,
    mint,
    plan,
  };
}

/** INTEGRATION.md §4.6 `getVault`. Exact lamports (round down is implicit: integers). `mint` saves a round trip. */
export async function getVault(placeId: string, mint?: string): Promise<VaultView> {
  return (await readVault(placeId, mint)).view;
}

/* ------------------------------------------------------------------------------------------ tx helpers */

/** A vault-operation tx: [CU limit, CU price (capped, ./budget), ...ixs]. */
async function buildSimple(payer: PublicKey, ixs: TransactionInstruction[], cuLimit: number): Promise<Built> {
  const cfg = chainConfig();
  const { blockhash, lastValidBlockHeight } = await latestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: vaultPriorityMicroLamports(cuLimit, cfg.priorityFeeMicroLamports) }),
      ...ixs,
    ],
  }).compileToV0Message();
  return { tx: new VersionedTransaction(msg), lastValidBlockHeight };
}

function tracker(onProgress: OnProgress) {
  const state = { sent: false, signature: undefined as string | undefined };
  const progress: OnProgress = (p) => {
    if (p.phase === 'preparing' || p.phase === 'awaiting-signature') {
      state.sent = false;
      state.signature = undefined;
    }
    if (p.signature) {
      state.sent = true;
      state.signature = p.signature;
    }
    onProgress(p);
  };
  return { state, progress };
}

/* ------------------------------------------------------------------------------------------ claims */

async function confirmClaim(claimId: string, signature: string): Promise<Extract<ClaimConfirmResponse, { status: 'pending_onchain' }>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await backend().claimConfirm({ claimId, signature });
      if (r.status === 'pending_onchain') return r;
    } catch (e) {
      if (!(e instanceof ApiError) || (e.status > 0 && e.status < 500 && e.status !== 429)) throw e;
    }
    if (Date.now() > deadline) {
      throw new TxFail('unconfirmed', { sent: true, signature, message: 'Your claim is on Solana, but recording it is taking a moment. Check back in a minute.' });
    }
    await sleep(1500);
  }
}

/** INTEGRATION.md §4.2 `requestClaim`: the connected wallet becomes the pending owner (it signs). */
export async function requestClaim(
  a: { placeId: string; claimId: string; claimToken: string },
  signer: WalletSigner,
  onProgress: OnProgress,
): Promise<TxOutcome<ClaimRequestValue>> {
  const { state, progress } = tracker(onProgress);
  try {
    const cfg = assertCanSign('Claiming');
    const newOwner = new PublicKey(signer.address);
    const attestor = new PublicKey(cfg.attestor);
    progress({ phase: 'preparing', step: 'vault' });
    const v = await readVault(a.placeId);
    if (!v.view.exists) throw new TxFail('claim', { message: "This shop doesn't have a coin yet." });
    if (v.view.pendingOwner) throw new TxFail('claim', { message: 'A claim for this shop is already in its public window.' });
    if (v.view.owner === signer.address) throw new TxFail('claim', { message: 'This wallet already owns this shop.' });
    let nonce = v.view.claimNonce + 1n;
    const landed = await executeWithRetry(
      async () => {
        progress({ phase: 'preparing', step: 'build' });
        const build = (n: bigint) => buildSimple(newOwner, [sv.requestClaim({ attestor, newOwner, placeHash: v.placeHash, nonce: n })], VAULT_CU.requestClaim);
        let b = await build(nonce);
        progress({ phase: 'preparing', step: 'cosign' });
        let co = await backend().claimCosign({ claimId: a.claimId, claimToken: a.claimToken, newOwner: signer.address, messageBase64: bytesToB64(b.tx.message.serialize()) });
        if (co.expectedNonce !== nonce.toString()) {
          // The chain moved (a claim was cancelled meanwhile): rebuild with the Worker's nonce and co-sign again.
          nonce = BigInt(co.expectedNonce);
          b = await build(nonce);
          co = await backend().claimCosign({ claimId: a.claimId, claimToken: a.claimToken, newOwner: signer.address, messageBase64: bytesToB64(b.tx.message.serialize()) });
        }
        if (co.attestor !== cfg.attestor) throw new TxFail('policy');
        b.tx.addSignature(attestor, b64ToBytes(co.attestorSignature));
        progress({ phase: 'preparing', step: 'simulate' });
        await simulate(b.tx);
        return b;
      },
      signer,
      progress,
    );
    progress({ phase: 'registering', walletName: signer.walletName, signature: landed.signature, explorerUrl: explorerTx(landed.signature) });
    const r = await confirmClaim(a.claimId, landed.signature);
    const explorerUrl = explorerTx(landed.signature);
    progress({ phase: 'done', walletName: signer.walletName, signature: landed.signature, explorerUrl });
    return { ok: true, signature: landed.signature, explorerUrl, value: { unlockTs: r.unlockTs, inProbation: r.inProbation, claimWindowSecs: r.claimWindowSecs } };
  } catch (e) {
    return { ok: false, error: toTxError(e, { ...state, walletName: signer.walletName }) };
  }
}

/** INTEGRATION.md §4.2 `finalizeClaim` (anyone, once now ≥ unlock_ts; the Worker cron also does it). */
export async function finalizeClaim(placeId: string, signer: WalletSigner, onProgress: OnProgress): Promise<TxOutcome<void>> {
  const { state, progress } = tracker(onProgress);
  try {
    assertCanSign('Finalizing');
    const payer = new PublicKey(signer.address);
    const { placeHash } = sv.placeAddresses(placeId);
    const landed = await executeWithRetry(
      async () => {
        progress({ phase: 'preparing', step: 'build' });
        const b = await buildSimple(payer, [sv.finalizeClaim({ placeHash })], VAULT_CU.finalizeClaim);
        progress({ phase: 'preparing', step: 'simulate' });
        await simulate(b.tx);
        return b;
      },
      signer,
      progress,
    );
    const explorerUrl = explorerTx(landed.signature);
    progress({ phase: 'done', walletName: signer.walletName, signature: landed.signature, explorerUrl });
    return { ok: true, signature: landed.signature, explorerUrl, value: undefined };
  } catch (e) {
    return { ok: false, error: toTxError(e, { ...state, walletName: signer.walletName }) };
  }
}

/* ------------------------------------------------------------------------------------------ withdraw */

/** The collect + withdraw instructions for the owner (SPEC §8.3): the steps of `v.plan`, then withdraw. */
export async function withdrawInstructions(owner: PublicKey, v: VaultRead): Promise<TransactionInstruction[]> {
  const ixs: TransactionInstruction[] = [];
  const { plan } = v;
  if (plan.curveSweep && v.mint) {
    const ops = await loadPump();
    ixs.push(await ops.sweepCreatorFeeIx({ payer: owner, mint: v.mint, creator: v.vault, quoteMint: new PublicKey(WSOL_MINT) }));
  }
  if (plan.poolSweep && v.mint) {
    const ops = await loadPump();
    ixs.push(await ops.sweepPoolCreatorFeeIx({ payer: owner, mint: v.mint, coinCreator: v.vault, quoteMint: new PublicKey(WSOL_MINT) }));
  }
  if (plan.ammTransfer) {
    const amm = await loadAmm();
    ixs.push(await amm.transferCreatorFeesToPumpIx(owner, v.vault));
  }
  if (plan.collect) ixs.push(collectCreatorFeeIx(v.vault));
  if (plan.unwrap) ixs.push(sv.unwrapWsol({ placeHash: v.placeHash, wsolAccount: sv.vaultWsolAta(v.vault) }));
  ixs.push(sv.withdraw({ owner, placeHash: v.placeHash }));
  return ixs;
}

/**
 * The withdraw result from the confirmed tx: what the owner received (their lamport delta), the vault payout (the
 * `Withdrawn` event) and what the tx cost them (payout − received: the network fee plus any one-time rent; the meta fee
 * alone when the payout is unknown). All null when the tx could not be read.
 */
export function withdrawOutcome(tx: TxJson | null, owner: string): WithdrawValue {
  if (!tx?.meta) return { lamports: null, withdrawnLamports: null, feeLamports: null };
  const withdrawnLamports = withdrawnAmount(tx.meta.logMessages);
  const delta = lamportDelta(tx, owner, false);
  const metaFee = BigInt(tx.meta.fee);
  const cost = withdrawnLamports !== null && delta !== null ? withdrawnLamports - delta : null;
  return {
    lamports: delta === null ? null : delta > 0n ? delta : 0n,
    withdrawnLamports,
    feeLamports: cost !== null && cost >= metaFee ? cost : metaFee,
  };
}

/**
 * INTEGRATION.md §4.2 `collectAndWithdraw` (owner only). Value = `withdrawOutcome`: what the owner received (their
 * lamport delta from the tx meta, §4.6), the gross vault payout (the shop-vault `Withdrawn` event) and what the tx cost
 * them. Never the gross alone: a first withdraw also pays pump's creator-vault rent, so the gross overstates what arrived.
 *
 * Refused before signing (`uneconomic`) when the estimated cost is at least the fees waiting, because the owner would
 * lose money. `acceptLoss` skips that check for tests and scripts; the UI never passes it.
 */
export async function collectAndWithdraw(
  placeId: string,
  signer: WalletSigner,
  onProgress: OnProgress,
  mint?: string,
  opts: { acceptLoss?: boolean } = {},
): Promise<TxOutcome<WithdrawValue>> {
  const { state, progress } = tracker(onProgress);
  try {
    assertCanSign('Withdrawing');
    const owner = new PublicKey(signer.address);
    const landed = await executeWithRetry(
      async () => {
        progress({ phase: 'preparing', step: 'vault' });
        const v = await readVault(placeId, mint);
        if (!v.view.exists) throw new TxFail('claim', { message: "This shop doesn't have a coin yet." });
        if (v.view.owner !== signer.address) throw new TxFail('claim', { message: "Only the shop owner's wallet can withdraw." });
        if (v.view.fees.total <= 0n) throw new TxFail('claim', { message: "There's nothing to withdraw yet." });
        const cost = v.view.withdrawCostLamports;
        if (!opts.acceptLoss && cost !== undefined && cost >= v.view.fees.total) throw new TxFail('uneconomic');
        progress({ phase: 'preparing', step: 'build' });
        let ixs = await withdrawInstructions(owner, v);
        // the full plan's limit (the one the cost estimate used); a trimmed tx below just uses less of it
        const cuLimit = withdrawCuLimit(v.plan);
        let b = await buildSimple(owner, ixs, cuLimit);
        // Drop optional leading steps (the sweeps first) if the tx would not fit.
        while (b.tx.serialize().length > TX_SIZE_LIMIT && ixs.length > 2) {
          ixs = ixs.filter((_, i) => i !== 0);
          b = await buildSimple(owner, ixs, cuLimit);
        }
        progress({ phase: 'preparing', step: 'simulate' });
        await simulate(b.tx);
        return b;
      },
      signer,
      progress,
    );
    // the Live feed shows the payout from the Worker's chain_events (recorded now instead of at the next monitor run)
    void backend().indexTx({ signature: landed.signature });
    const value = withdrawOutcome(await fetchTx(landed.signature), signer.address);
    const explorerUrl = explorerTx(landed.signature);
    progress({ phase: 'done', walletName: signer.walletName, signature: landed.signature, explorerUrl });
    return { ok: true, signature: landed.signature, explorerUrl, value };
  } catch (e) {
    return { ok: false, error: toTxError(e, { ...state, walletName: signer.walletName }) };
  }
}

/** Exposed for the Worker-free e2e and tests. */
export { readVault };
