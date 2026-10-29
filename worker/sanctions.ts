/**
 * Wallet screening against the Solana addresses on the OFAC SDN list (worker/data/sanctioned-wallets.json, rebuilt by
 * `node scripts/update-sanctions.mjs` from Treasury's sdn_advanced.xml, feature "Digital Currency Address - SOL").
 *
 * Refused with `wallet_blocked` (HTTP 451): a sanctioned launcher at launch prepare and a sanctioned payout wallet at
 * claim co-sign. /api/rpc refuses a sendTransaction whose bytes contain a sanctioned address anywhere (the fee payer,
 * any other static account, or instruction data such as pump's `creator` argument) with JSON-RPC error
 * RPC_WALLET_BLOCKED. It scans the raw bytes instead of decoding the transaction, so nothing the node would accept
 * (trailing bytes, a message version our codec does not know) slips past; lookup-table accounts are not resolved (no
 * RPC read on the send path). Screening never depends on GEO_BLOCK: it applies wherever the visitor is.
 *
 * Every refusal raises a `sanctioned_wallet` alert (the address is public on-chain data; at most once an hour per
 * address). Nothing here checks a signature, so an alert means a request *named* a listed wallet, not that its owner
 * sent it: anyone can paste a public address into a request.
 */
import { alert, type Ctx } from './ctx';
import { b58decodeLen, b58encode, fromB64 } from './bytes';
import list from './data/sanctioned-wallets.json';
import { ApiErr } from './http';

let sanctioned: ReadonlySet<string> = new Set(list.addresses);
/** The same list as 32-byte keys, for the raw transaction scan. */
let sanctionedKeys: readonly Uint8Array[] = keysOf(sanctioned);

/** Never throws at module load (a bad entry must not take the Worker down; the list's tests catch it). */
function keysOf(addresses: ReadonlySet<string>): Uint8Array[] {
  return [...addresses].map((a) => b58decodeLen(a, 32)).filter((k): k is Uint8Array => k !== null);
}

function keyAt(b: Uint8Array, o: number, k: Uint8Array): boolean {
  for (let j = 0; j < 32; j++) if (b[o + j] !== k[j]) return false;
  return true;
}

export const WALLET_BLOCKED_MESSAGE = "This wallet can't be used on AtlasPad.";

/** True when the address is on the list. */
export function isSanctionedWallet(address: string | null | undefined): boolean {
  return !!address && sanctioned.has(address);
}

/**
 * The first sanctioned address found anywhere in a base64 wire transaction (≤ 1232 bytes × a handful of keys), or
 * null. A raw scan, not a decode: the node accepts transactions our codec refuses (trailing bytes), so a decode
 * failure must never mean "clean". A random 32-byte match is impossible in practice. Never throws.
 */
export function sanctionedInTx(txBase64: unknown): string | null {
  if (sanctionedKeys.length === 0 || typeof txBase64 !== 'string') return null;
  let b: Uint8Array;
  try {
    b = fromB64(txBase64);
  } catch {
    return null; // not base64: the param rules (worker/rpcProxy.ts) already refuse it
  }
  for (let o = 0; o + 32 <= b.length; o++) {
    for (const k of sanctionedKeys) if (b[o] === k[0] && keyAt(b, o, k)) return b58encode(k);
  }
  return null;
}

/** Records a refusal (alert + log). Best effort; never throws. */
export function reportSanctioned(ctx: Ctx, address: string, what: string): void {
  ctx.log.warn('compliance.wallet_blocked', { what });
  const message = `Refused a ${what} request naming ${address} (on the OFAC sanctions list); nothing was co-signed or relayed. Signatures are not checked here, so the request may not come from that wallet's owner.`;
  ctx.waitUntil(alert(ctx, 'warn', 'sanctioned_wallet', message, address));
}

/** Throws `wallet_blocked` for a sanctioned wallet (and records it). */
export function assertWalletAllowed(ctx: Ctx, address: string, what: 'launch' | 'claim payout'): void {
  if (!isSanctionedWallet(address)) return;
  reportSanctioned(ctx, address, what);
  throw new ApiErr('wallet_blocked', WALLET_BLOCKED_MESSAGE);
}

/** Test helper: replace the list (null restores the committed one). */
export function __setSanctionedWallets(addresses: readonly string[] | null): void {
  sanctioned = new Set(addresses ?? list.addresses);
  sanctionedKeys = keysOf(sanctioned);
}
