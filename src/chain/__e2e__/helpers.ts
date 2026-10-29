/**
 * Node-only helpers for the chain unit tests and the devnet e2e (never imported by app code).
 *  - keypairSigner: a WalletSigner backed by a local Keypair (what the devnet test wallet does in the browser).
 *  - LocalBackend: the Worker's launch/claim routes re-implemented in-process for the e2e: it decodes the message
 *    ITSELF, runs the SPEC §8.4 policy (`checkLaunchMessage` / `checkClaimMessage`) and co-signs with the devnet
 *    attestor key — the key is loaded from .keys/ by the e2e and never printed.
 */
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, VersionedMessage, VersionedTransaction, type AddressLookupTableAccount } from '@solana/web3.js';
import * as sv from '@cornershop/shop-vault-client';
import type {
  ClaimConfirmResponse,
  ClaimCosignRequest,
  ClaimCosignResponse,
  CoinDTO,
  IndexTxResponse,
  LaunchConfirmResponse,
  LaunchCosignRequest,
  LaunchCosignResponse,
  LaunchPrepareRequest,
  LaunchPrepareResponse,
  MetadataUploadResponse,
} from '../../../worker/wire';
import type { ChainBackend, MetadataUpload } from '../api';
import { ApiError } from '../errors';
import { b64ToBytes, bytesToB64, getMultipleAccountsRaw, rpc } from '../rpc';
import type { WalletSigner } from '../types';

export function keypairSigner(kp: Keypair, walletName = 'Test Keypair', chain: 'solana:devnet' | 'solana:mainnet' = 'solana:devnet'): WalletSigner {
  return {
    address: kp.publicKey.toBase58(),
    walletName,
    chain,
    async signTransaction(bytes: Uint8Array): Promise<Uint8Array> {
      const tx = VersionedTransaction.deserialize(bytes);
      tx.sign([kp]);
      return tx.serialize();
    },
  };
}

/** Sign exactly `msg.serialize()` as `kp` and return the base64 signature (what worker/attestor.ts does). */
export function attestorSignature(kp: Keypair, msg: VersionedMessage): string {
  const t = new VersionedTransaction(msg);
  t.sign([kp]);
  const i = msg.staticAccountKeys.findIndex((k) => k.equals(kp.publicKey));
  if (i < 0) throw new Error('attestor is not a signer of this message');
  return bytesToB64(t.signatures[i]);
}

interface Reservation {
  req: LaunchPrepareRequest;
  meta: MetadataUploadResponse;
  placeHash: Uint8Array;
  expiresAt: number;
}

export interface LocalBackendOptions {
  attestor: Keypair;
  publicOrigin: string;
  alt: AddressLookupTableAccount;
  maxDevBuyLamports: bigint;
  priorityFeeMicroLamports: number;
  /** Records every co-signed launch message size (serialized tx with 3 signatures). */
  onLaunchMessage?: (sizeWithSignatures: number, violations: string[]) => void;
}

export class LocalBackend implements ChainBackend {
  readonly reservations = new Map<string, Reservation>();
  readonly metadata = new Map<string, MetadataUploadResponse & { placeId: string }>();
  readonly claims = new Map<string, { placeId: string; newOwner?: string; nonce?: bigint }>();
  constructor(private o: LocalBackendOptions) {}

  async uploadMetadata(m: MetadataUpload): Promise<MetadataUploadResponse> {
    const json = JSON.stringify({ name: m.name.normalize('NFC'), symbol: m.symbol, description: m.description, placeId: m.placeId });
    const id = createHash('sha256').update(json).digest('hex').slice(0, 32);
    const img = createHash('sha256').update(new Uint8Array(await m.image.arrayBuffer())).digest('hex').slice(0, 32);
    const out: MetadataUploadResponse = {
      metadataId: id,
      uri: `${this.o.publicOrigin}/meta/${id}.json`,
      imageUrl: `${this.o.publicOrigin}/img/${img}.png`,
      name: m.name.normalize('NFC'),
      symbol: m.symbol,
    };
    this.metadata.set(id, { ...out, placeId: m.placeId });
    return out;
  }

  async launchPrepare(r: LaunchPrepareRequest): Promise<LaunchPrepareResponse> {
    const meta = this.metadata.get(r.metadataId);
    if (!meta || meta.placeId !== r.placeId) throw new ApiError(400, { error: 'bad_request', message: 'metadata' });
    const placeHash = sv.placeHash(r.placeId);
    const [vault] = sv.vaultPda(placeHash);
    const [vaultState] = sv.vaultStatePda(placeHash);
    const [existing] = await getMultipleAccountsRaw([vaultState.toBase58()]);
    if (existing) throw new ApiError(409, { error: 'taken' });
    const bh = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const id = createHash('sha256').update(`${r.mint}:${Date.now()}`).digest('base64url').slice(0, 22);
    const expiresAt = Date.now() + 120_000;
    this.reservations.set(id, { req: r, meta, placeHash, expiresAt });
    return {
      reservationId: id,
      placeId: r.placeId,
      placeHash: sv.toHex(placeHash),
      vault: vault.toBase58(),
      vaultState: vaultState.toBase58(),
      name: meta.name,
      symbol: meta.symbol,
      uri: meta.uri,
      attestor: this.o.attestor.publicKey.toBase58(),
      alt: this.o.alt.key.toBase58(),
      programId: sv.SHOP_VAULT_PROGRAM_ID.toBase58(),
      configPda: sv.configPda()[0].toBase58(),
      maxDevBuyLamports: this.o.maxDevBuyLamports.toString(),
      computeUnitLimit: 400_000,
      priorityFeeMicroLamports: this.o.priorityFeeMicroLamports,
      blockhash: bh.value.blockhash,
      lastValidBlockHeight: bh.value.lastValidBlockHeight,
      expiresAt,
    };
  }

  async launchCosign(r: LaunchCosignRequest): Promise<LaunchCosignResponse> {
    const res = this.reservations.get(r.reservationId);
    if (!res || Date.now() > res.expiresAt) throw new ApiError(410, { error: 'reservation_expired' });
    const bytes = b64ToBytes(r.messageBase64);
    const msg = VersionedMessage.deserialize(bytes);
    const canonical = Buffer.from(msg.serialize()).equals(Buffer.from(bytes));
    const violations = canonical
      ? sv.checkLaunchMessage(msg, {
          attestor: this.o.attestor.publicKey,
          launcher: new PublicKey(res.req.launcher),
          mint: new PublicKey(res.req.mint),
          placeHash: res.placeHash,
          name: res.meta.name,
          symbol: res.meta.symbol,
          uri: res.meta.uri,
          maxDevBuyLamports: this.o.maxDevBuyLamports,
          lookupTable: this.o.alt,
          maxComputeUnitLimit: 600_000,
          maxComputeUnitPriceMicroLamports: 5_000_000n,
        })
      : ['non-canonical message'];
    this.o.onLaunchMessage?.(1 + 3 * 64 + bytes.length, violations);
    if (violations.length) throw new ApiError(422, { error: 'policy_violation', violations });
    return { attestor: this.o.attestor.publicKey.toBase58(), attestorSignature: attestorSignature(this.o.attestor, msg), lockedUntil: Date.now() + 120_000 };
  }

  async launchConfirm(r: { reservationId: string; signature: string }): Promise<LaunchConfirmResponse> {
    const res = this.reservations.get(r.reservationId);
    if (!res) throw new ApiError(404, { error: 'not_found' });
    const st = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>('getSignatureStatuses', [[r.signature], { searchTransactionHistory: false }]);
    const s = st.value[0];
    if (!s || (s.confirmationStatus !== 'confirmed' && s.confirmationStatus !== 'finalized')) return { status: 'pending' };
    if (s.err) throw new ApiError(422, { error: 'not_confirmed', message: JSON.stringify(s.err) });
    const [vaultState] = sv.vaultStatePda(res.placeHash);
    const [acc] = await getMultipleAccountsRaw([vaultState.toBase58()]);
    if (!acc) return { status: 'pending' };
    const v = sv.decodeVaultState(acc.data);
    if (v.mint.toBase58() !== res.req.mint || v.launcher.toBase58() !== res.req.launcher) throw new ApiError(422, { error: 'not_confirmed', message: 'vault state mismatch' });
    const coin = {
      placeId: res.req.placeId,
      placeHash: sv.toHex(res.placeHash),
      mint: res.req.mint,
      vault: sv.vaultPda(res.placeHash)[0].toBase58(),
      vaultState: vaultState.toBase58(),
      bondingCurve: sv.bondingCurvePda(new PublicKey(res.req.mint)).toBase58(),
      ticker: res.meta.symbol,
      name: res.meta.name,
      launchSig: r.signature,
    } as unknown as CoinDTO;
    return { status: 'registered', coin };
  }

  async claimCosign(r: ClaimCosignRequest): Promise<ClaimCosignResponse> {
    const c = this.claims.get(r.claimId);
    if (!c || r.claimToken !== `token:${r.claimId}`) throw new ApiError(422, { error: 'claim_not_verified' });
    if (c.newOwner && c.newOwner !== r.newOwner) throw new ApiError(422, { error: 'wrong_owner' });
    c.newOwner = r.newOwner;
    const ph = sv.placeHash(c.placeId);
    const [acc] = await getMultipleAccountsRaw([sv.vaultStatePda(ph)[0].toBase58()]);
    if (!acc) throw new ApiError(422, { error: 'no_coin' });
    const st = sv.decodeVaultState(acc.data);
    if (st.pending) throw new ApiError(409, { error: 'claim_pending' });
    const expectedNonce = st.claimNonce + 1n;
    const bytes = b64ToBytes(r.messageBase64);
    const msg = VersionedMessage.deserialize(bytes);
    const violations = sv.checkClaimMessage(msg, { attestor: this.o.attestor.publicKey, newOwner: new PublicKey(r.newOwner), placeHash: ph, expectedNonce });
    if (violations.length) throw new ApiError(422, { error: 'policy_violation', violations });
    c.nonce = expectedNonce;
    return { attestor: this.o.attestor.publicKey.toBase58(), attestorSignature: attestorSignature(this.o.attestor, msg), expectedNonce: expectedNonce.toString() };
  }

  async claimConfirm(r: { claimId: string; signature: string }): Promise<ClaimConfirmResponse> {
    const c = this.claims.get(r.claimId);
    if (!c) throw new ApiError(404, { error: 'not_found' });
    const [acc] = await getMultipleAccountsRaw([sv.vaultStatePda(sv.placeHash(c.placeId))[0].toBase58()]);
    const st = acc ? sv.decodeVaultState(acc.data) : null;
    if (!st?.pending || st.pending.owner.toBase58() !== c.newOwner || st.claimNonce !== c.nonce) return { status: 'pending' };
    const cfg = await getMultipleAccountsRaw([sv.configPda()[0].toBase58()]);
    const window = cfg[0] ? Number(sv.decodeConfig(cfg[0].data).claimWindowSecs) : 0;
    return { status: 'pending_onchain', unlockTs: Number(st.pending.unlockTs), inProbation: st.pending.inProbation, claimWindowSecs: window };
  }

  async indexTx(): Promise<IndexTxResponse | null> {
    return null;
  }

  /** Test-only: a verified claim session (what /api/claim/call + /check would produce). */
  startVerifiedClaim(placeId: string): { claimId: string; claimToken: string } {
    const claimId = `e2e-${Date.now()}`;
    this.claims.set(claimId, { placeId });
    return { claimId, claimToken: `token:${claimId}` };
  }
}
