/**
 * Claim public-window copy (INTEGRATION.md §7.5): `72-hour` (259200 s, mainnet), `1-minute` (60 s,
 * devnet), from on-chain Config `claim_window_secs`. Pure.
 */
export function formatWindow(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600}-hour`;
  if (s >= 60 && s % 60 === 0) return `${s / 60}-minute`;
  return `${s}-second`;
}
