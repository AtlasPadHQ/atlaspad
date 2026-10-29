/**
 * Cluster-aware Solscan links (INTEGRATION.md §7.6). Light module.
 * Devnet links carry `?cluster=devnet`; mainnet links have no suffix. In demo mode (CLUSTER null) the build cluster
 * is used when there is one, otherwise mainnet-style links (demo coins never have real signatures anyway).
 * `/api/config` explorer templates, when given to `setExplorerTemplates`, win (same URLs, server-controlled).
 */
import { BUILD_CLUSTER, CLUSTER, type Cluster } from '../mode';

interface Templates {
  tx: string;
  address: string;
  token: string;
}

let templates: Templates | null = null;

/** Called by initChain with `config.explorer` (placeholders {sig} / {address} / {mint}). Ignored if malformed. */
export function setExplorerTemplates(t: Partial<Templates> | null | undefined): void {
  if (!t || typeof t.tx !== 'string' || typeof t.address !== 'string' || typeof t.token !== 'string') return;
  const ok = (s: string) => /^https:\/\/[a-z0-9.-]+\//i.test(s);
  if (ok(t.tx) && ok(t.address) && ok(t.token) && t.tx.includes('{sig}') && t.address.includes('{address}') && t.token.includes('{mint}')) {
    templates = { tx: t.tx, address: t.address, token: t.token };
  }
}

function cluster(): Cluster {
  return CLUSTER ?? BUILD_CLUSTER ?? 'mainnet';
}

function suffix(c: Cluster): string {
  return c === 'devnet' ? '?cluster=devnet' : '';
}

const enc = encodeURIComponent;

export function explorerTx(sig: string, c: Cluster = cluster()): string {
  if (templates && c === cluster()) return templates.tx.replace('{sig}', enc(sig));
  return `https://solscan.io/tx/${enc(sig)}${suffix(c)}`;
}

export function explorerAddress(address: string, c: Cluster = cluster()): string {
  if (templates && c === cluster()) return templates.address.replace('{address}', enc(address));
  return `https://solscan.io/account/${enc(address)}${suffix(c)}`;
}

export function explorerToken(mint: string, c: Cluster = cluster()): string {
  if (templates && c === cluster()) return templates.token.replace('{mint}', enc(mint));
  return `https://solscan.io/token/${enc(mint)}${suffix(c)}`;
}
