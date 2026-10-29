/**
 * Devnet sign-off evidence for scripts/go-mainnet.mjs (MAINNET-CHECKLIST §1): the e2e and accuracy-audit reports in
 * scripts/out must describe the code that is about to go live. A report counts only when it ran AFTER the latest
 * devnet deploy record (a deploy-devnet run that deployed the Worker or the program) and is at most 7 days old;
 * otherwise it is stale. Plus the graduation waiver: pump.fun's devnet migration bot never migrated our test coin
 * (PumpSwap pool 4MhKxT85… does not exist, programs/shop-vault/DEVNET.md), so the GRADUATE=1 run cannot pass on
 * devnet; `--waive-graduation "<reason>"` records that decision in scripts/out/go-mainnet-state.json.
 * Pure helpers plus small directory reads; no network.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_EVIDENCE_AGE_DAYS = 7;
const DAY_MS = 86_400_000;
/** The devnet PumpSwap pool of the e2e graduation coin that pump's migration bot never created (DEVNET.md). */
export const DEVNET_GRADUATION_POOL = '4MhKxT85ohkLzvSyBeNHRynV5kaX9TLdA3ZdzgYJ29Ez';
export const MIN_WAIVER_REASON = 10;

/** `…-20261008T221619.json` → epoch ms (UTC), or null. */
export function stampFromName(file) {
  const m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(String(file));
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** When a report ran (epoch ms): startedAt (e2e), at (accuracy audit), else the file name stamp. */
export function reportTime(json, file) {
  for (const k of ['startedAt', 'at']) {
    const t = Date.parse(json?.[k] ?? '');
    if (Number.isFinite(t)) return t;
  }
  return stampFromName(file);
}

/** True when a deploy-devnet record deployed something (the Worker, or the program on --upgrade-program). */
export function isDeployRecord(json) {
  return json?.execute === true && (json.results?.deploy?.ok === true || json.results?.program?.deployed === true);
}

/** The latest devnet deploy record in `outDir`: { file, at } (at = finishedAt, else startedAt / name stamp), or null. */
export function latestDevnetDeploy(outDir) {
  if (!existsSync(outDir)) return null;
  let best = null;
  for (const f of readdirSync(outDir).filter((x) => x.startsWith('deploy-devnet-') && x.endsWith('.json'))) {
    let json;
    try {
      json = JSON.parse(readFileSync(join(outDir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!isDeployRecord(json)) continue;
    const at = Date.parse(json.finishedAt ?? '') || reportTime(json, f);
    if (Number.isFinite(at) && (!best || at > best.at)) best = { file: f, at };
  }
  return best;
}

const day = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/**
 * Why a report is stale, or null when it is fresh: it must run after the latest devnet deploy and be at most
 * `maxAgeDays` old.
 * @param {{ at: number|null, deploy: { file: string, at: number }|null, now: number, maxAgeDays?: number }} o
 */
export function staleReason({ at, deploy, now, maxAgeDays = MAX_EVIDENCE_AGE_DAYS }) {
  if (!Number.isFinite(at)) return 'no run time in the report';
  if (deploy && at <= deploy.at) return `ran ${day(at)}, before the latest devnet deploy ${deploy.file} (${day(deploy.at)}): re-run it against the deployed code`;
  if (now - at > maxAgeDays * DAY_MS) return `ran ${day(at)}, more than ${maxAgeDays} days ago`;
  return null;
}

/**
 * Validates `--waive-graduation "<reason>"` (parseArgs gives `true` when the reason is missing).
 * @param {unknown} arg  the flag value
 * @param {boolean|null} poolExists  whether the devnet pool exists now (null = could not check)
 * @returns {{ waiver: { reason: string, pool: string, poolExists: boolean|null }|null, problems: string[] }}
 */
export function graduationWaiver(arg, poolExists) {
  if (arg === undefined || arg === false) return { waiver: null, problems: [] };
  const reason = typeof arg === 'string' ? arg.trim() : '';
  const problems = [];
  if (reason.length < MIN_WAIVER_REASON) problems.push(`--waive-graduation needs a reason of at least ${MIN_WAIVER_REASON} characters, in quotes`);
  if (poolExists === true) problems.push(`the devnet pool ${DEVNET_GRADUATION_POOL} exists now: run the graduation test (GRADUATE=1 npm run e2e:devnet -- --execute) instead of waiving it`);
  return { waiver: problems.length ? null : { reason, pool: DEVNET_GRADUATION_POOL, poolExists }, problems };
}
