#!/usr/bin/env node
/**
 * Pre-register a PLANNED admin proposal (SPEC §8.6, INTEGRATION §3.7 program monitor). The Worker's monitor and
 * scripts/watchdog.mjs treat every AdminChanged proposal WITHOUT a matching row as hostile (critical alert; the
 * guardian must veto an unregistered attestor/guardian proposal within 7 days). Register BEFORE proposing.
 *
 *   node scripts/admin-expect.mjs --env mainnet add --kind attestor-proposed --key <new pubkey> --note "routine rotation"
 *   node scripts/admin-expect.mjs --env mainnet list
 *
 * kinds (SPEC §7 AdminChanged): paused(0) attestor-proposed(1) attestor-applied(2) attestor-cancelled(3)
 * governance-proposed(4) governance-applied(5) guardian-proposed(6) guardian-applied(7) guardian-cancelled(8)
 * governance-withdrawn(9). Values are validated (base58 key, note charset) before they reach SQL.
 */
import { isAddress } from './lib/b58.mjs';
import { fatal, head, info, ok, parseArgs } from './lib/log.mjs';
import { d1Execute } from './lib/wrangler.mjs';

export const ADMIN_KINDS = {
  paused: 0,
  'attestor-proposed': 1,
  'attestor-applied': 2,
  'attestor-cancelled': 3,
  'governance-proposed': 4,
  'governance-applied': 5,
  'guardian-proposed': 6,
  'guardian-applied': 7,
  'guardian-cancelled': 8,
  'governance-withdrawn': 9,
};

export function parseKind(v) {
  if (/^\d$/.test(String(v))) return Number(v);
  const k = ADMIN_KINDS[String(v)];
  if (k === undefined) throw new Error(`unknown kind ${v} (${Object.keys(ADMIN_KINDS).join(', ')})`);
  return k;
}

export function expectationSql({ kind, key, note, now = Date.now() }) {
  if (!Number.isInteger(kind) || kind < 0 || kind > 9) throw new Error('kind must be 0..9');
  if (!isAddress(key)) throw new Error('key must be a base58 public key');
  const n = String(note ?? '');
  if (!/^[A-Za-z0-9 .,:_/()#-]{0,200}$/.test(n)) throw new Error('note: letters, digits, spaces and . , : _ / ( ) # - only, ≤ 200 chars');
  return `INSERT INTO admin_expectations (kind, key, note, created_at) VALUES (${kind}, '${key}', '${n}', ${Math.floor(now)})`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), []);
  const env = args.env;
  const [cmd] = args._;
  if (!['devnet', 'mainnet'].includes(env) || !['add', 'list'].includes(cmd)) {
    console.error('usage: node scripts/admin-expect.mjs --env devnet|mainnet add --kind <kind> --key <pubkey> [--note text] | list');
    process.exit(64);
  }
  head(`admin-expect · ${env} · ${cmd}`);
  if (cmd === 'list') {
    const names = Object.fromEntries(Object.entries(ADMIN_KINDS).map(([k, v]) => [v, k]));
    const rows = await d1Execute(env, 'SELECT id, kind, key, note, created_at FROM admin_expectations ORDER BY id DESC LIMIT 100');
    if (!rows.length) info('no registered expectations');
    for (const r of rows) console.log(`#${r.id} ${new Date(r.created_at).toISOString()} ${names[r.kind] ?? r.kind} ${r.key}${r.note ? ` — ${r.note}` : ''}`);
    return;
  }
  const sql = expectationSql({ kind: parseKind(args.kind), key: String(args.key ?? ''), note: typeof args.note === 'string' ? args.note : '' });
  await d1Execute(env, sql);
  ok('registered; now make the proposal (and keep this row until it is applied or withdrawn)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fatal(e.message));
}
