/**
 * Parse what someone pasted in the Report sheet's `Coin link or mint` field (Phase-1 minor #5):
 * a `/c/<mint>` link (any origin) or a bare base58 mint. Returns the mint, or null. Pure.
 */
import { isAddress } from '../chain/base58';

export function mintFromCoinRef(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const m = t.match(/\/c\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/);
  const cand = m?.[1] ?? t;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cand) && isAddress(cand) ? cand : null;
}
