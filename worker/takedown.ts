/**
 * Takedowns (RUNBOOK "Moderation and takedown requests"): business opt-outs and the retention of report data.
 *
 * Opt-outs: `scripts/moderate.mjs --optout <placeId>` records the place in `place_optouts` (migration 0003) and hides
 * its coin, if it has one. Launch prepare then refuses the place (`place_opted_out`) and eligibility reports
 * `opted_out`, also when no coin exists yet. The site's opt-out form only files a report: an unverified request must not
 * let anyone block a business, so ops check the requester first.
 *
 * Hidden and opted-out coins are hidden from discovery (map, lists, feed, search, share pages), never from their
 * owner: claims and withdrawals keep working (worker/claims.ts reads coins whatever their status).
 *
 * Retention: the personal part of a report (an opt-out's name and email, free-text details, the reporter's IP hash)
 * is scrubbed after 180 days by the indexer's hourly retention job; the kind, place, mint, reason and date stay.
 */
import { DAY } from './ctx';

export const REPORT_PERSONAL_DATA_DAYS = 180;

/** True when any of `placeIds` (e.g. the requested id and Google's canonical id) is opted out. */
export async function placeOptedOut(db: D1Database, ...placeIds: string[]): Promise<boolean> {
  const ids = [...new Set(placeIds.filter((p) => typeof p === 'string' && p.length > 0))];
  if (!ids.length) return false;
  try {
    const row = await db
      .prepare(`SELECT 1 AS x FROM place_optouts WHERE place_id IN (${ids.map((_, i) => `?${i + 1}`).join(',')}) LIMIT 1`)
      .bind(...ids)
      .first();
    return !!row;
  } catch (e) {
    // deploy order: a Worker that runs before migration 0003 is applied must not break every place page and launch
    if (/no such table/i.test(String(e))) return false;
    throw e;
  }
}

/** The retention statements for reports (run hourly in the indexer's `retention` job). */
export function reportRetentionStmts(db: D1Database, now: number): D1PreparedStatement[] {
  return [
    db
      .prepare('UPDATE reports SET details = NULL, contact = NULL, ip_hash = NULL WHERE created_at < ?1 AND (details IS NOT NULL OR contact IS NOT NULL OR ip_hash IS NOT NULL)')
      .bind(now - REPORT_PERSONAL_DATA_DAYS * DAY),
  ];
}
