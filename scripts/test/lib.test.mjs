// node --test scripts/test/   (no network, no secrets: pure functions and fabricated fixtures only)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseSol } from '../lib/amounts.mjs';
import { b58decode, b58encode, isAddress, isSignature } from '../lib/b58.mjs';
import { parseChecklist } from '../lib/checklist.mjs';
import { writeDeploy } from '../lib/deployJson.mjs';
import { parseDotenv } from '../lib/env.mjs';
import { curveNumbers, decodeCurve, decodeEvents, poolNumbers } from '../lib/events.mjs';
import { fmtSol, parseArgs, redact } from '../lib/log.mjs';
import { ALT_KEY_LIST, ROOT } from '../lib/paths.mjs';
import { findLeaks } from '../lib/secrets.mjs';
import { DEVNET_ONLY_SECRETS, putSecret, putSecretsBulk, secretSources } from '../lib/secretPut.mjs';
import { decodeMultisig, multisigProblems } from '../lib/squads.mjs';
import { ATLASPAD_CLOUDFLARE_ACCOUNT_ID, envProblems, expectedAccountId, parseJsonc, replaceD1Placeholder, stripJsonc, whoamiAccountIds } from '../lib/wrangler.mjs';

const KEY_A = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
const KEY_B = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';

test('parseDotenv: quotes, comments, export, inline comments', () => {
  const m = parseDotenv('# c\nexport A=1\nB="two words"\nC=\'x#y\'\nD=val # note\n\nE=\n bad line\n');
  assert.equal(m.get('A'), '1');
  assert.equal(m.get('B'), 'two words');
  assert.equal(m.get('C'), 'x#y');
  assert.equal(m.get('D'), 'val');
  assert.equal(m.get('E'), '');
  assert.equal(m.has('bad'), false);
});

test('redact: provider keys in URLs, auth headers and seed-phrase lines never survive', () => {
  const s = redact('GET https://solana-devnet.g.alchemy.com/v2/AbC123_xyz-987 failed\nAuthorization: Basic dXNlcjpwYXNz\nhttps://x.example/?api-key=SECRET1&y=2\nSave this seed phrase to recover\nok line');
  assert.ok(!s.includes('AbC123_xyz-987'));
  assert.ok(s.includes('g.alchemy.com/v2/[redacted]'));
  assert.ok(!s.includes('dXNlcjpwYXNz'));
  assert.ok(!s.includes('SECRET1'));
  assert.ok(!/seed phrase/i.test(s));
  assert.ok(s.includes('ok line'));
});

test('parseArgs: booleans never swallow positionals', () => {
  const a = parseArgs(['--execute', 'devnet', '--env', 'mainnet', '--x=1', '--', '--raw'], ['execute']);
  assert.equal(a.execute, true);
  assert.deepEqual(a._, ['devnet', '--raw']);
  assert.equal(a.env, 'mainnet');
  assert.equal(a.x, '1');
});

test('fmtSol / parseSol are exact', () => {
  assert.equal(fmtSol(1_500_000_000n), '1.5 SOL');
  assert.equal(fmtSol(1n), '0.000000001 SOL');
  assert.equal(fmtSol(-2_000_000_000n), '-2 SOL');
  assert.equal(parseSol('0.6'), 600_000_000n);
  assert.equal(parseSol('3'), 3_000_000_000n);
  assert.equal(parseSol('0.000000001'), 1n);
  assert.throws(() => parseSol('0.0000000001'));
  assert.throws(() => parseSol('-1'));
  assert.throws(() => parseSol('1e9'));
});

test('base58 round trip and address/signature checks', () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 37) & 0xff);
  assert.deepEqual([...b58decode(b58encode(bytes))], [...bytes]);
  assert.equal(b58encode(new Uint8Array(32)), '11111111111111111111111111111111');
  for (const k of ALT_KEY_LIST) assert.ok(isAddress(k), k);
  assert.equal(isAddress('not-an-address'), false);
  assert.equal(isAddress("abc'; DROP TABLE coins;--"), false);
  assert.equal(isSignature(b58encode(new Uint8Array(64).fill(7))), true);
});

test('ALT_KEYS has the 14 frozen keys, no duplicates', () => {
  assert.equal(ALT_KEY_LIST.length, 14);
  assert.equal(new Set(ALT_KEY_LIST).size, 14);
  assert.equal(ALT_KEY_LIST[13], 'Sysvar1nstructions1111111111111111111111111');
});

test('deploy json refuses unknown fields and non-address values (no secret can land there)', () => {
  assert.throws(() => writeDeploy('devnet', { ATTESTOR_SECRET: 'x' }), /unknown field/);
  assert.throws(() => writeDeploy('devnet', { alt: 'not base58!' }), /not a base58 address/);
  assert.throws(() => writeDeploy('devnet', { claimWindowSecs: '60' }), /integer/);
  assert.throws(() => writeDeploy('staging', { alt: KEY_A }), /devnet or mainnet/);
});

test('secret sources: DEV_FAUCET_SECRET only on devnet; mainnet requires Turnstile, Twilio is optional', () => {
  const dev = secretSources('devnet').map((s) => s.name);
  const main = secretSources('mainnet');
  assert.ok(dev.includes('DEV_FAUCET_SECRET'));
  assert.ok(dev.includes('ALCHEMY_API_KEY'));
  assert.ok(!dev.includes('HELIUS_API_KEY'));
  assert.ok(!main.some((s) => DEVNET_ONLY_SECRETS.includes(s.name)));
  for (const n of ['ALCHEMY_API_KEY', 'ATTESTOR_SECRET', 'CRANK_SECRET', 'HMAC_KEY']) {
    assert.equal(main.find((s) => s.name === n)?.required, true, n);
  }
  // mainnet launches without phone calls: Twilio, the Turnstile that guards its call step, and the alert channels are
  // set when present, never required here (go-mainnet requires Turnstile only with Twilio, and one alert channel always)
  for (const n of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SID', 'TURNSTILE_SECRET_KEY', 'ALERT_WEBHOOK_URL', 'ALERT_EMAIL_TO']) {
    assert.equal(main.find((s) => s.name === n)?.required, false, n);
  }
});

test('putSecret / putSecretsBulk refuse DEV_FAUCET_SECRET on mainnet before calling wrangler', async () => {
  await assert.rejects(() => putSecret('DEV_FAUCET_SECRET', 'abc', 'mainnet'), /never exist on mainnet/);
  await assert.rejects(() => putSecretsBulk({ GOOGLE_SERVER_KEY: 'a', DEV_FAUCET_SECRET: 'b' }, 'mainnet'), /never exist on mainnet/);
  await assert.rejects(() => putSecretsBulk({ 'bad name': 'a' }, 'devnet'), /bad secret name/);
  await assert.rejects(() => putSecretsBulk({ A_B: 'line1\nline2' }, 'devnet'), /newline/);
  await assert.rejects(() => putSecret('X_Y', 'v', 'production'), /devnet or mainnet/);
});

test('findLeaks reports names only, for text and raw bytes', () => {
  const secrets = [{ name: 'S1', value: 'super-secret-value-123' }];
  const seeds = [{ name: 'seed', bytes: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) }];
  assert.deepEqual(findLeaks('var x="super-secret-value-123"', secrets), ['S1']);
  assert.deepEqual(findLeaks(Buffer.concat([Buffer.from('xx'), seeds[0].bytes]), secrets, seeds), ['seed']);
  assert.deepEqual(findLeaks('clean', secrets, seeds), []);
});

test('JSONC: comments and trailing commas stripped, strings untouched', () => {
  const t = '{\n // c\n "a": "http://x//y", /* b */ "b": [1,2,],\n}';
  assert.deepEqual(parseJsonc(t), { a: 'http://x//y', b: [1, 2] });
  assert.ok(stripJsonc('"/* not a comment */"').includes('/* not a comment */'));
});

test('envProblems enforces the H4/H6 shape of env.devnet / env.mainnet', () => {
  const good = {
    env: {
      devnet: { name: 'cornershop-devnet', vars: { CLUSTER: 'devnet' }, define: { __CS_DEV_ENDPOINTS__: 'true', __CS_CLUSTER__: '"devnet"' }, d1_databases: [{ binding: 'DB', database_name: 'cornershop-devnet' }] },
      mainnet: { name: 'cornershop', vars: { CLUSTER: 'mainnet' }, define: { __CS_DEV_ENDPOINTS__: 'false', __CS_CLUSTER__: '"mainnet"' }, d1_databases: [{ binding: 'DB', database_name: 'cornershop-mainnet' }], assets: { directory: './dist-mainnet' } },
    },
  };
  assert.deepEqual(envProblems('devnet', good), []);
  assert.deepEqual(envProblems('mainnet', good), []);
  const bad = structuredClone(good);
  bad.env.mainnet.define.__CS_DEV_ENDPOINTS__ = 'true';
  bad.env.mainnet.assets.directory = './dist-devnet';
  bad.env.devnet.name = 'cornershop';
  assert.ok(envProblems('mainnet', bad).some((p) => /H6/.test(p)));
  assert.ok(envProblems('mainnet', bad).some((p) => /devnet build/.test(p)));
  assert.ok(envProblems('devnet', bad).some((p) => /expected "cornershop-devnet"/.test(p)));
  assert.match(envProblems('devnet', {})[0], /no env.devnet/);
});

test('replaceD1Placeholder replaces the exact token once, refuses ambiguity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-wr-'));
  const p = join(dir, 'wrangler.jsonc');
  const cfg = (id) => `{ "env": { "devnet": { "d1_databases": [{ "binding": "DB", "database_name": "cornershop-devnet", "database_id": "${id}" }] } } }`;
  writeFileSync(p, cfg('__D1_DEVNET_ID__'));
  const uuid = '01234567-89ab-cdef-0123-456789abcdef';
  assert.equal(replaceD1Placeholder('devnet', uuid, p), true);
  assert.match(readFileSync(p, 'utf8'), new RegExp(uuid));
  assert.equal(replaceD1Placeholder('devnet', uuid, p), false); // already replaced: no-op
  writeFileSync(p, cfg('__D1_DEVNET_ID__') + '// __D1_DEVNET_ID__');
  assert.throws(() => replaceD1Placeholder('devnet', uuid, p), /appears 2 times/);
  assert.throws(() => replaceD1Placeholder('devnet', 'not-a-uuid', p), /uuid/);
});

test('docs name only the CS_* environment variables the code reads (the wrangler account override is CS_CLOUDFLARE_ACCOUNT_ID)', () => {
  const files = (dir, re) => readdirSync(join(ROOT, dir), { recursive: true }).filter((f) => re.test(f) && !/\.test\.|(^|\/)test\//.test(f)).map((f) => join(dir, f));
  const code = [...files('scripts', /\.(mjs|sh)$/), ...files('worker', /\.ts$/), ...files('src', /\.tsx?$/), ...files('.github', /\.yml$/), 'vite.config.ts']
    .map((f) => readFileSync(join(ROOT, f), 'utf8'))
    .join('\n');
  const docs = ['README.md', 'RUNBOOK.md', 'INTEGRATION.md', 'CONTRACTS.md', 'DESIGN.md', 'CHANGELOG.md', ...files('docs', /\.md$/)];
  for (const doc of docs) {
    for (const name of new Set(readFileSync(join(ROOT, doc), 'utf8').match(/\bCS_[A-Z0-9_]+\b/g) ?? [])) {
      assert.ok(new RegExp(`\\b${name}\\b`).test(code), `${doc} names ${name}, which no script, Worker or app code reads`);
    }
  }
  assert.match(readFileSync(join(ROOT, 'RUNBOOK.md'), 'utf8'), /npx wrangler whoami .*CS_CLOUDFLARE_ACCOUNT_ID/);
});

test('wrangler account check: by account id (CS_CLOUDFLARE_ACCOUNT_ID, else AtlasPad), never by name or email', () => {
  assert.match(ATLASPAD_CLOUDFLARE_ACCOUNT_ID, /^[0-9a-f]{32}$/);
  assert.equal(expectedAccountId({}), ATLASPAD_CLOUDFLARE_ACCOUNT_ID);
  assert.equal(expectedAccountId({ CS_CLOUDFLARE_ACCOUNT_ID: '  ' }), ATLASPAD_CLOUDFLARE_ACCOUNT_ID);
  assert.equal(expectedAccountId({ CS_CLOUDFLARE_ACCOUNT_ID: ` ${'AB'.repeat(16)}\n` }), 'ab'.repeat(16));
  assert.throws(() => expectedAccountId({ CS_CLOUDFLARE_ACCOUNT_ID: 'my-account' }), /32-character hex/);
  assert.throws(() => expectedAccountId({ CS_CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(33) }), /32-character hex/);

  // `wrangler whoami --json` (4.x): only accounts[].id counts; the email and the "<email>'s Account" name are ignored
  const A = '0123456789abcdef0123456789abcdef';
  const B = 'fedcba9876543210fedcba9876543210';
  const json = { loggedIn: true, authType: 'OAuth Token', email: 'someone@example.com', accounts: [{ id: A, name: "someone@example.com's Account" }, { id: B.toUpperCase(), name: B }], tokenPermissions: ['account (read)'] };
  assert.deepEqual(whoamiAccountIds(JSON.stringify(json, null, 2)), [A, B]);
  assert.deepEqual(whoamiAccountIds(JSON.stringify({ ...json, accounts: [{ id: 'not-an-id' }] })), []);
  // plain-text whoami: the ids in the account table, nothing from other lines
  const table = [
    `👋 You are logged in with an OAuth Token, associated with the email ${'c'.repeat(32)}@example.com`,
    '┌─────────────────────────┬──────────────────────────────────┐',
    '│ Account Name            │ Account ID                       │',
    '├─────────────────────────┼──────────────────────────────────┤',
    `│ someone's Account       │ ${A} │`,
    '└─────────────────────────┴──────────────────────────────────┘',
  ].join('\n');
  assert.deepEqual(whoamiAccountIds(table), [A]);
  assert.deepEqual(whoamiAccountIds(''), []);
  assert.deepEqual(whoamiAccountIds(undefined), []);

  // every deploy script uses the id check with no hard-coded account
  for (const f of ['deploy-devnet.mjs', 'deploy-mainnet-hotfix.mjs', 'go-mainnet.mjs']) {
    const text = readFileSync(join(ROOT, 'scripts', f), 'utf8');
    assert.match(text, /await whoamiMatches\(\);/, f);
    assert.ok(!/whoamiMatches\(['"`]/.test(text), `${f} passes a literal account to whoamiMatches`);
    assert.match(text, /wrangler logged in to the AtlasPad Cloudflare account/, f);
  }
});

test('checklist parser counts ticked and unticked boxes per section', () => {
  const r = parseChecklist('# T\n## 1. A\n- [x] done\n- [ ] open one\n  - [X] nested ok\n## 2. B\n* [ ] another\ntext - [ ] not a box? yes it is not at line start\n');
  assert.equal(r.items.length, 4);
  assert.equal(r.unchecked.length, 2);
  assert.equal(r.unchecked[0].section, '1. A');
  assert.equal(r.unchecked[1].text, 'another');
});

test('the shipped MAINNET-CHECKLIST.md parses and starts fully unticked', () => {
  const r = parseChecklist(readFileSync(new URL('../../MAINNET-CHECKLIST.md', import.meta.url), 'utf8'));
  assert.ok(r.items.length >= 30);
  assert.equal(r.unchecked.length, r.items.length);
});

function multisigBytes({ threshold, timeLock, members, configAuthority = new Uint8Array(32), rentCollector = null }) {
  const parts = [Buffer.alloc(8), Buffer.alloc(32, 9), Buffer.from(configAuthority)];
  const t = Buffer.alloc(2);
  t.writeUInt16LE(threshold);
  const tl = Buffer.alloc(4);
  tl.writeUInt32LE(timeLock);
  parts.push(t, tl, Buffer.alloc(16), rentCollector ? Buffer.concat([Buffer.from([1]), Buffer.from(rentCollector)]) : Buffer.from([0]), Buffer.from([255]));
  const n = Buffer.alloc(4);
  n.writeUInt32LE(members.length);
  parts.push(n);
  for (const m of members) parts.push(Buffer.concat([Buffer.from(m.key), Buffer.from([m.permissions])]));
  return Buffer.concat(parts);
}

test('Squads v4 multisig decode + governance rules (SPEC T11b)', () => {
  const members = [1, 2, 3].map((i) => ({ key: new Uint8Array(32).fill(i), permissions: 7 }));
  const ok = decodeMultisig(multisigBytes({ threshold: 2, timeLock: 43_200, members }));
  assert.equal(ok.threshold, 2);
  assert.equal(ok.timeLock, 43_200);
  assert.equal(ok.members.length, 3);
  assert.equal(ok.configAuthority, null);
  assert.deepEqual(multisigProblems(ok, { role: 'governance', claimWindowSecs: 259_200 }), []);
  const slow = decodeMultisig(multisigBytes({ threshold: 2, timeLock: 200_000, members }));
  assert.ok(multisigProblems(slow, { role: 'governance', claimWindowSecs: 259_200 }).some((p) => /time lock/.test(p)));
  assert.deepEqual(multisigProblems(slow, { role: 'upgrade', claimWindowSecs: 259_200 }), []); // B may be slow
  const solo = decodeMultisig(multisigBytes({ threshold: 1, timeLock: 0, members: members.slice(0, 1), configAuthority: new Uint8Array(32).fill(5), rentCollector: new Uint8Array(32).fill(6) }));
  const sp = multisigProblems(solo, { role: 'governance', claimWindowSecs: 259_200 });
  assert.ok(sp.some((p) => /threshold/.test(p)));
  assert.ok(sp.some((p) => /voting members/.test(p)));
  assert.ok(sp.some((p) => /config_authority/.test(p)));
  assert.throws(() => decodeMultisig(Buffer.alloc(20)), /too short/);
});

test('event decoding: pump TradeEvent from an event-CPI inner instruction', () => {
  const body = Buffer.alloc(217);
  Buffer.from(b58decode(KEY_A)).copy(body, 0); // mint
  body.writeBigUInt64LE(100_000_000n, 32); // sol
  body.writeBigUInt64LE(3_000_000_000_000n, 40); // tokens
  body[48] = 1; // is_buy
  Buffer.from(b58decode(KEY_B)).copy(body, 49); // user
  body.writeBigInt64LE(1_760_000_000n, 81);
  body.writeBigUInt64LE(1_100_000_000n, 89);
  body.writeBigUInt64LE(900_000_000_000_000n, 97);
  Buffer.from(b58decode(KEY_B)).copy(body, 169); // creator
  body.writeBigUInt64LE(300_000n, 209);
  const data = Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), Buffer.from('bddb7fd34ee661ee', 'hex'), body]);
  const ev = decodeEvents({ innerInstructions: [{ index: 3, instructions: [{ data: b58encode(Buffer.from('junk')) }, { data: b58encode(data) }] }] });
  assert.equal(ev.length, 1);
  assert.deepEqual({ ...ev[0], vSol: undefined, vTok: undefined }, { kind: 'trade', ix: 0, mint: KEY_A, sol: 100_000_000n, tokens: 3_000_000_000_000n, isBuy: true, user: KEY_B, ts: 1_760_000_000_000, vSol: undefined, vTok: undefined, creator: KEY_B, creatorFee: 300_000n });
});

test('curve maths match src/chain/curve.ts (exact bigint, 15-digit price, 2 dp progress)', () => {
  const d = Buffer.alloc(150);
  d.writeBigUInt64LE(1_073_000_000_000_000n, 8); // vTok
  d.writeBigUInt64LE(30_000_000_000n, 16); // vSol
  d.writeBigUInt64LE(793_100_000_000_000n, 24); // realTok
  d.writeBigUInt64LE(0n, 32);
  d.writeBigUInt64LE(1_000_000_000_000_000n, 40); // supply
  const c = decodeCurve(d);
  const n = curveNumbers(c, 793_100_000_000_000n);
  assert.equal(n.mcapLamports, (30_000_000_000n * 1_000_000_000_000_000n) / 1_073_000_000_000_000n);
  const scaled = (30_000_000_000n * 10n ** 6n * 10n ** 15n) / 1_073_000_000_000_000n;
  assert.equal(n.priceLamports, Number(scaled / 10n ** 15n) + Number(scaled % 10n ** 15n) / 1e15);
  assert.equal(n.progressPct, 0);
  c.realTok = 396_550_000_000_000n;
  assert.equal(curveNumbers(c, 793_100_000_000_000n).progressPct, 50);
  c.complete = true;
  assert.equal(curveNumbers(c, 793_100_000_000_000n).progressPct, 100);
  assert.equal(poolNumbers(0n, 5n).priceLamports, 0);
  assert.equal(poolNumbers(2_000_000n, 1_000n).priceLamports, 500);
  assert.equal(poolNumbers(2_000_000n, 1_000n, -400n).priceLamports, 300); // signed virtual quote (v2 fee accrual)
});

test('SPEC §3.1 place_hash test vector', () => {
  assert.equal(createHash('sha256').update('ChIJN1t_tDeuEmsRUsoyG83frY4').digest('hex'), '52791f4bf8f035bc928405e161a4c28a262db717cfe91ae8d3615563066afa15');
});

test('parseArgs: on/off flags never take a value, and --execute is always on/off', () => {
  assert.throws(() => parseArgs(['--execute=false']), /on\/off flag/);
  assert.throws(() => parseArgs(['--execute=0'], ['execute']), /on\/off flag/);
  assert.throws(() => parseArgs(['--json=no'], ['json']), /on\/off flag/);
  assert.deepEqual(parseArgs(['--execute', 'mint123']), { _: ['mint123'], execute: true });
  assert.deepEqual(parseArgs(['--cluster', 'devnet', '--execute']), { _: [], cluster: 'devnet', execute: true });
  assert.deepEqual(parseArgs(['--cluster=mainnet']), { _: [], cluster: 'mainnet' });
});
