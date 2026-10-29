#!/usr/bin/env node
/**
 * Moderation and takedowns (INTEGRATION §10.2, RUNBOOK "Moderation and takedown requests"). UI-only and reversible:
 * a hidden coin disappears from the map, lists, feed and search; the on-chain coin and the shop's fees are untouched.
 *
 *   node scripts/moderate.mjs --env devnet --hide <mint> [--execute]
 *   node scripts/moderate.mjs --env devnet --unhide <mint> [--execute]
 *   node scripts/moderate.mjs --env devnet --optout <placeId> [--execute]     # business opt-out: no coin, ever
 *   node scripts/moderate.mjs --env devnet --optin <placeId> [--execute]      # lift an opt-out (launches allowed)
 *   node scripts/moderate.mjs --env devnet --reports [--limit 30] [--show-contact]
 *   node scripts/moderate.mjs --env devnet --hidden                             # list hidden coins
 *   node scripts/moderate.mjs --env devnet --optouts                            # list opted-out places
 *
 * `--optout` records the place in `place_optouts` (launch prepare then refuses it with place_opted_out, whether or not
 * it has a coin yet) and hides its coin if there is one. The hidden coin's fees stay claimable by the verified owner.
 * `--optin` only lifts the launch block; a hidden coin stays hidden until `--unhide <mint>`.
 *
 * Every interpolated value is validated against a strict charset first (base58 mint, Google/test place id), so the
 * SQL passed to `wrangler d1 execute --remote` cannot be injected. Dry run by default (prints the SQL).
 * `--reports` prints the reporter's contact only with --show-contact (personal data; use it to reply, then forget it).
 */
import { isAddress } from './lib/b58.mjs';
import { bad, fatal, head, info, ok, parseArgs } from './lib/log.mjs';
import { d1Execute } from './lib/wrangler.mjs';

export const PLACE_ID_RE = /^(?:[A-Za-z0-9_-]{10,300}|cornershop-test:[a-z0-9-]{1,40})$/;

/** SQL for an action (values validated; throws otherwise). */
export function moderationSql(action, value, now = Date.now()) {
  if (action === 'hide' || action === 'unhide') {
    if (!isAddress(value)) throw new Error('mint must be a base58 address');
    return `UPDATE coins SET status = '${action === 'hide' ? 'hidden' : 'live'}', updated_at = ${Math.floor(now)} WHERE mint = '${value}'`;
  }
  if (action === 'optout' || action === 'optin') {
    if (!PLACE_ID_RE.test(value)) throw new Error('placeId must be a Google place id (or a devnet test id)');
    if (action === 'optin') return `DELETE FROM place_optouts WHERE place_id = '${value}'`;
    return (
      `INSERT OR IGNORE INTO place_optouts(place_id, created_at) VALUES ('${value}', ${Math.floor(now)}); ` +
      `UPDATE coins SET status = 'hidden', updated_at = ${Math.floor(now)} WHERE place_id = '${value}'`
    );
  }
  throw new Error(`unknown action ${action}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['execute', 'reports', 'hidden', 'optouts', 'show-contact']);
  const env = args.env;
  if (env !== 'devnet' && env !== 'mainnet') fatal('--env devnet|mainnet', 64);
  head(`moderate · ${env}`);

  if (args.reports) {
    const limit = Math.min(200, Math.max(1, Number(args.limit ?? 30) | 0));
    const cols = `id, kind, place_id, mint, reason, substr(coalesce(details, ''), 1, 160) AS details, created_at${args['show-contact'] ? ', contact' : ''}`;
    const rows = await d1Execute(env, `SELECT ${cols} FROM reports ORDER BY id DESC LIMIT ${limit}`);
    if (!rows.length) info('no reports');
    for (const r of rows) {
      console.log(`#${r.id} ${new Date(r.created_at).toISOString()} ${r.kind.padEnd(12)} ${r.reason} · place ${r.place_id ?? '—'} · mint ${r.mint ?? '—'}${r.contact ? ` · contact ${r.contact}` : ''}`);
      if (r.details) console.log(`    ${r.details}`);
    }
    return;
  }
  if (args.hidden) {
    const rows = await d1Execute(env, `SELECT mint, ticker, name, place_id, updated_at FROM coins WHERE status = 'hidden' ORDER BY updated_at DESC LIMIT 200`);
    if (!rows.length) info('no hidden coins');
    for (const r of rows) console.log(`$${r.ticker} ${r.mint} · ${r.name} · place ${r.place_id} · since ${new Date(r.updated_at).toISOString()}`);
    return;
  }

  if (args.optouts) {
    const rows = await d1Execute(env, 'SELECT place_id, created_at FROM place_optouts ORDER BY created_at DESC LIMIT 200');
    if (!rows.length) info('no opted-out places');
    for (const r of rows) console.log(`${r.place_id} · since ${new Date(r.created_at).toISOString()}`);
    return;
  }

  const action = ['hide', 'unhide', 'optout', 'optin'].find((a) => typeof args[a] === 'string');
  if (!action) fatal('one of --hide <mint> | --unhide <mint> | --optout <placeId> | --optin <placeId> | --reports | --hidden | --optouts', 64);
  const sql = moderationSql(action, args[action]);
  const byPlace = action === 'optout' || action === 'optin';
  const where = `${byPlace ? 'place_id' : 'mint'} = '${args[action]}'`;
  const before = await d1Execute(env, `SELECT mint, ticker, place_id, status FROM coins WHERE ${where}`);
  // an opt-out also works before the place has a coin: it blocks every future launch
  if (!before.length && !byPlace) fatal(`no coin with ${where} on ${env}`);
  if (!before.length) info(`place ${args[action]} has no coin on ${env}${action === 'optout' ? ': every launch for it will be refused' : ''}`);
  for (const r of before) info(`$${r.ticker} ${r.mint} · place ${r.place_id} · status ${r.status}`);
  if (!args.execute) {
    info(`would run on ${env}: ${sql}`);
    info('dry run; add --execute');
    return;
  }
  await d1Execute(env, sql);
  if (byPlace) {
    const listed = await d1Execute(env, `SELECT place_id FROM place_optouts WHERE ${where}`);
    if ((listed.length > 0) === (action === 'optout')) ok(`${action}: place ${args[action]} ${action === 'optout' ? 'is opted out (launches refused)' : 'can be launched again'}`);
    else bad(`unexpected opt-out state after ${action}`);
    if (action === 'optin' || !before.length) return;
  }
  const after = await d1Execute(env, `SELECT status FROM coins WHERE ${where}`);
  const want = action === 'unhide' ? 'live' : 'hidden';
  if (after.every((r) => r.status === want)) ok(`${action}: ${after.length} coin(s) now ${want} (lists refresh within their cache time, ≤ 30 s)`);
  else bad(`unexpected status after ${action}: ${after.map((r) => r.status).join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fatal(e.message));
}
