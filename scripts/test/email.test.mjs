// node --test scripts/test/   (the free alert email: go-mainnet's "webhook OR email" rule, the ALERT_EMAIL_TO secret
// source, the send_email binding in wrangler.jsonc, the watchdog's GitHub failed-run email, a repository-wide guard
// that no personal Gmail address is ever committed, and the public-tree guard: nothing the public repository publishes
// names the operator, holds a home-directory path or a Google key). Pure logic and repository files only: no network,
// no wrangler.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ALERT_CHANNEL_FIX, alertChannels, alertChannelsText, alertEmailProblems, optionalSecretProblems, TWILIO_SECRETS } from '../go-mainnet.mjs';
import { isPlainEmailAddress } from '../lib/env.mjs';
import { ROOT } from '../lib/paths.mjs';
import { secretSources } from '../lib/secretPut.mjs';
import { envConfig, readWranglerConfig } from '../lib/wrangler.mjs';

/** A placeholder: real addresses never appear in the repository. */
const TO = 'owner@example.com';
const MAINNET = () => envConfig('mainnet', readWranglerConfig());

test('go-mainnet: owner alerts need ALERT_WEBHOOK_URL OR ALERT_EMAIL_TO (webhook only passes, email only passes, neither fails)', () => {
  const names = (missing) => optionalSecretProblems(missing).map((p) => p.name);
  // Twilio is off at launch in every case below
  const webhookOnly = [...TWILIO_SECRETS, 'ALERT_EMAIL_TO'];
  const emailOnly = [...TWILIO_SECRETS, 'ALERT_WEBHOOK_URL'];
  const neither = [...TWILIO_SECRETS, 'ALERT_WEBHOOK_URL', 'ALERT_EMAIL_TO'];
  assert.deepEqual(names(webhookOnly), []);
  assert.deepEqual(alertChannels(webhookOnly), ['webhook']);
  assert.deepEqual(names(emailOnly), []);
  assert.deepEqual(alertChannels(emailOnly), ['email']);
  assert.deepEqual(alertChannels([...TWILIO_SECRETS]), ['webhook', 'email']);
  assert.deepEqual(names(neither), ['owner alerts']);
  assert.deepEqual(alertChannels(neither), []);
  const p = optionalSecretProblems(neither)[0];
  assert.match(p.detail, /neither ALERT_EMAIL_TO nor ALERT_WEBHOOK_URL/);
  assert.equal(p.fix, ALERT_CHANNEL_FIX);
  assert.match(p.fix, /ALERT_EMAIL_TO=<an address verified in Cloudflare Email Routing> to \.env\.server \(free/);
  assert.match(p.fix, /Discord channel webhook as ALERT_WEBHOOK_URL/);
  // the pass line names the channel(s) that are set
  assert.match(alertChannelsText(['email']), /^email to ALERT_EMAIL_TO from alerts@atlaspad\.online \(Cloudflare Email Routing, free\): /);
  assert.match(alertChannelsText(['webhook']), /^Discord\/Slack webhook \(ALERT_WEBHOOK_URL\): /);
  assert.match(alertChannelsText(['webhook', 'email']), /ALERT_EMAIL_TO .* \+ Discord\/Slack webhook/);
});

test('go-mainnet: with ALERT_EMAIL_TO set, env.mainnet must have the ALERT_EMAIL send_email binding (no destination address)', () => {
  assert.deepEqual(alertEmailProblems({ emailTo: TO, envCfg: MAINNET() }), [], 'the repo wrangler.jsonc passes');
  const names = (o) => alertEmailProblems(o).map((p) => p.name);
  const base = MAINNET();
  assert.deepEqual(names({ emailTo: TO, envCfg: { ...base, send_email: undefined } }), ['ALERT_EMAIL binding']);
  assert.match(alertEmailProblems({ emailTo: TO, envCfg: { ...base, send_email: [{ name: 'OTHER' }] } })[0].fix, /"send_email": \[\{ "name": "ALERT_EMAIL" \}\]/);
  assert.deepEqual(names({ emailTo: TO, envCfg: { ...base, send_email: [{ name: 'ALERT_EMAIL', destination_address: TO }] } }), ['ALERT_EMAIL binding']);
  assert.deepEqual(names({ emailTo: TO, envCfg: { ...base, send_email: [{ name: 'ALERT_EMAIL', allowed_destination_addresses: [TO] }] } }), ['ALERT_EMAIL binding']);
  assert.deepEqual(names({ emailTo: `Owner <${TO}>`, envCfg: base }), ['ALERT_EMAIL_TO']);
  assert.deepEqual(names({ emailTo: `${TO}, second@example.com`, envCfg: base }), ['ALERT_EMAIL_TO']);
  assert.deepEqual(names({ emailTo: TO, envCfg: { ...base, vars: { ...base.vars, ALERT_EMAIL_FROM: 'alerts@other.example' } } }), ['ALERT_EMAIL_FROM']);
  assert.deepEqual(names({ emailTo: TO, envCfg: { ...base, vars: { ...base.vars, ALERT_EMAIL_FROM: undefined } } }), [], 'unset = the Worker default');
  // a problem never prints the recipient
  const all = alertEmailProblems({ emailTo: `Owner <${TO}>`, envCfg: { ...base, send_email: [] } });
  assert.ok(!JSON.stringify(all).includes(TO));
});

test('isPlainEmailAddress: the same rule as the Worker (worker/email.ts cleanAddress)', () => {
  for (const ok of [TO, 'first.last+alerts@mail.example.co.uk', ' owner@example.com ']) assert.equal(isPlainEmailAddress(ok), true, ok);
  for (const bad of ['', undefined, 'owner@example', `Owner <${TO}>`, `${TO}, b@example.com`, 'a b@example.com', '.a@example.com', 'a.@example.com', 'a..b@example.com', `${TO}\nBcc: x@example.com`]) {
    assert.equal(isPlainEmailAddress(bad), false, JSON.stringify(bad));
  }
});

test('secret sources: ALERT_EMAIL_TO is an optional .env.server secret on devnet and mainnet', () => {
  for (const env of ['devnet', 'mainnet']) {
    const s = secretSources(env).find((x) => x.name === 'ALERT_EMAIL_TO');
    assert.deepEqual(s, { name: 'ALERT_EMAIL_TO', source: 'env:ALERT_EMAIL_TO', required: false }, env);
    assert.equal(secretSources(env).find((x) => x.name === 'ALERT_WEBHOOK_URL')?.required, false, env);
  }
});

test('wrangler.jsonc: an unrestricted ALERT_EMAIL send_email binding on mainnet and devnet; no recipient address anywhere', () => {
  const cfg = readWranglerConfig();
  for (const env of ['mainnet', 'devnet']) {
    const e = envConfig(env, cfg);
    assert.deepEqual(e.send_email, [{ name: 'ALERT_EMAIL' }], `env.${env}.send_email`);
    assert.equal(e.vars.ALERT_EMAIL_FROM, 'alerts@atlaspad.online', `env.${env}.vars.ALERT_EMAIL_FROM`);
    assert.ok(!('ALERT_EMAIL_TO' in e.vars), 'the recipient is a secret, never a var');
  }
  assert.equal(cfg.send_email, undefined, 'the demo Worker gets no email binding');
  assert.equal(cfg.vars?.ALERT_EMAIL_FROM, undefined);
  // the only address in the file is the public sender: no destination_address, no recipient, no personal mailbox
  const text = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const addresses = [...text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0]);
  assert.ok(addresses.length >= 2);
  assert.deepEqual([...new Set(addresses)], ['alerts@atlaspad.online']);
  assert.ok(!/"destination_address"|"allowed_destination_addresses"/.test(text));
});

test('watchdog workflow: a critical result fails the job (GitHub emails the failed run); the webhook is optional', () => {
  const yml = readFileSync(join(ROOT, '.github', 'workflows', 'watchdog.yml'), 'utf8');
  assert.match(yml, /node scripts\/watchdog\.mjs --cluster mainnet --alert/);
  assert.match(yml, /^\s*2\) echo "::error::watchdog: CRITICAL[^\n]*; exit 1 ;;$/m);
  assert.ok(!/continue-on-error/.test(yml));
  // no step fails, or is skipped, for a missing ALERT_WEBHOOK_URL
  assert.ok(!/ALERT_WEBHOOK_URL[^\n]*exit 1/.test(yml));
  assert.ok(!/if:[^\n]*ALERT_WEBHOOK_URL/.test(yml));
  // the daily D1 backup is optional too: no hard failure without the Cloudflare token (D1 Time Travel restores anyway)
  const backup = readFileSync(join(ROOT, '.github', 'workflows', 'd1-backup.yml'), 'utf8');
  assert.ok(!/::error::Add the CLOUDFLARE_API_TOKEN/.test(backup));
  assert.match(backup, /HAS_TOKEN/);
});

test("'cloudflare:email' is imported only lazily, by worker/email.ts, and never by browser code", (t) => {
  const files = repoFiles();
  if (!files) return t.skip('git is not available');
  const code = files.filter((f) => /^(worker|src)\/.*\.tsx?$/.test(f) && existsSync(join(ROOT, f)));
  assert.ok(code.length > 50, `${code.length} TypeScript files`);
  // import/export statements only (comments mention the module by name)
  const STATIC = /^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]cloudflare:email['"]|^\s*import\s*['"]cloudflare:email['"]/m;
  const DYNAMIC = /\bimport\(\s*['"]cloudflare:email['"]\s*\)/;
  const lazy = [];
  for (const f of code) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    // a static import would make vitest (Node) and any bundle that reaches the module resolve it
    assert.ok(!STATIC.test(text), `${f} imports 'cloudflare:email' statically`);
    if (DYNAMIC.test(text)) lazy.push(f);
    // the browser app never reaches the alert senders (worker/email.ts, worker/notify.ts and their importers)
    if (f.startsWith('src/')) assert.ok(!/['"][./]*worker\/(?:email|notify|ctx|ownerAlerts|webhook)['"]/.test(text), `${f} imports a Worker alert module`);
  }
  assert.deepEqual(lazy, ['worker/email.ts']);
});

const GMAIL = /[A-Za-z0-9._%+-]+@(?:gmail|googlemail)\.com\b/i;

/** Files git tracks, plus new files it would track (not ignored); null when git is unavailable. */
function repoFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter(Boolean);
  } catch {
    return null;
  }
}

test('no Gmail address in any tracked source, config or doc file (the owner address lives only in .env.server)', (t) => {
  const files = repoFiles();
  if (!files) return t.skip('git is not available');
  const hits = [];
  let scanned = 0;
  for (const f of files) {
    const p = join(ROOT, f);
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    const buf = readFileSync(p);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary (images, fonts, video)
    scanned++;
    if (GMAIL.test(buf.toString('utf8'))) hits.push(f); // the file name only: never print the address
  }
  assert.ok(scanned > 100, `scanned ${scanned} files`);
  assert.deepEqual(hits, [], `a Gmail address is committed in: ${hits.join(', ')}`);
  assert.ok(files.includes('.env.example') && !files.includes('.env.server'), '.env.server stays untracked');
});

// ---- public-tree guard ----------------------------------------------------------------------------------------------
// The public repository leaves out research/, videos/, marketing/, BRIEF.md and design/* except design/og-card.html,
// and the root .gitignore lists them. "Excluded" is asked of git with --no-index, so this passes on a branch that still
// tracks them and in the public repository, where they are gone. Hits name the file, line and rule, never the text.

/** sha256 of the two lower-cased words (the owner's personal handle and name) that must never be published. */
const PRIVATE_WORD_SHA256 = new Set([
  '080a4a1571224fd19c5e53be04635cda834aa2bb7a9e17af8aa95b24001203fd',
  '98d4256a654bc8a19eea9f42c71cc41ea311e5e40d03ec27cc684d33f55132d7',
]);

const PUBLIC_TREE_RULES = [
  ['absolute macOS home path', /\/Users\//],
  ['Gmail address', GMAIL],
  // the owner's personal GitHub account, spelt in two halves so this file passes its own guard
  ['personal GitHub account', new RegExp(['tip', 'pybot'].join(''), 'i')],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
];

/** What the plan leaves out of the public tree; anything else the root .gitignore skips here is an error. */
const PUBLIC_TREE_EXCLUDED = /^(?:research|videos|marketing)\/|^BRIEF\.md$|^design\/(?!og-card\.html$)/;

/** The paths the root .gitignore (not .git/info/exclude or a global excludes file) ignores; null when git fails. */
function ignoredByRootGitignore(paths) {
  const r = spawnSync('git', ['check-ignore', '--no-index', '-v', '-z', '--stdin'], { cwd: ROOT, input: paths.join('\0'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || (r.status !== 0 && r.status !== 1)) return null; // 1 = nothing ignored
  const f = r.stdout.split('\0');
  const ignored = new Set();
  // -v -z: source, line, pattern, path per match; a "!" pattern matched means the path is published after all
  for (let i = 0; i + 3 < f.length; i += 4) if (f[i] === '.gitignore' && !f[i + 2].startsWith('!')) ignored.add(f[i + 3]);
  return ignored;
}

/**
 * Word tokens of a line, lower-cased: letter runs, camel-case parts and each part joined to the next, so "AtlasPad",
 * "ATLASPAD1", "atlas_pad" and "Atlas Pad" all reach the hash compare as "atlaspad".
 */
function wordTokens(line) {
  const parts = line.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? [];
  const out = (line.match(/[A-Za-z]+/g) ?? []).map((w) => w.toLowerCase());
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i].toLowerCase();
    out.push(w);
    if (i + 1 < parts.length) out.push(w + parts[i + 1].toLowerCase());
  }
  return out;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const tokenHashes = new Map();
/** True when a word token of the line hashes to one of `hashes` (each distinct token is hashed once). */
function hasHashedWord(line, hashes) {
  return wordTokens(line).some((w) => {
    let h = tokenHashes.get(w);
    if (h === undefined) tokenHashes.set(w, (h = sha256(w)));
    return hashes.has(h);
  });
}

/** "file:line (rule)" for every hit in one file's text. */
function publicTreeHits(file, text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const [rule, re] of PUBLIC_TREE_RULES) if (re.test(line)) hits.push(`${file}:${i + 1} (${rule})`);
    if (hasHashedWord(line, PRIVATE_WORD_SHA256)) hits.push(`${file}:${i + 1} (operator's handle or name)`);
  });
  return hits;
}

test('public-tree guard: the rules catch what they are for, and only that', () => {
  const name = (s) => publicTreeHits('f', s).map((h) => h.replace(/^f:\d+ /, ''));
  assert.deepEqual(name(['/Users', 'someone', 'x'].join('/')), ['(absolute macOS home path)']);
  assert.deepEqual(name(`key ${'AIza'}${'b'.repeat(35)}`), ['(Google API key)']);
  assert.deepEqual(name(`ping ${'someone'}@${'gmail'}.com`), ['(Gmail address)']);
  assert.deepEqual(name(`by ${['Tip', 'pyBot1'].join('')}`), ['(personal GitHub account)']);
  // ordinary text passes: hello@ on our own domain, a lower-case users API path, a Maps key placeholder (the path is
  // joined so the plan's case-insensitive grep stays empty on this file)
  assert.deepEqual(name(`hello@atlaspad.online, GET ${['', 'api', 'users', '1'].join('/')}, VITE_GOOGLE_MAPS_KEY=AIza...`), []);
  // the guarded words appear nowhere in the repo, so the token hash compare is checked with a stand-in word
  assert.deepEqual(wordTokens('AtlasPad x9_y'), ['atlaspad', 'x', 'y', 'atlas', 'atlaspad', 'pad', 'padx', 'x', 'xy', 'y']);
  const standIn = new Set([sha256('atlaspad')]);
  for (const s of ['AtlasPad', 'ATLASPAD1', 'atlas_pad', 'Atlas Pad', 'by atlasPad.', 'the atlasPadApp']) assert.ok(hasHashedWord(s, standIn), s);
  for (const s of ['atlas', 'atlaspadel', 'Atlas Padel', 'atlas pads']) assert.ok(!hasHashedWord(s, standIn), s);
});

test('public-tree guard: the root .gitignore leaves out exactly the unpublished paths', (t) => {
  const probe = ['research/x.md', 'videos/a/b.html', 'marketing/x.md', 'BRIEF.md', 'design/x.png', 'design/mock/index.html', 'design/og-card.html', 'README.md', 'docs/OPS-AUTOMATION.md', 'src/main.tsx'];
  const ignored = ignoredByRootGitignore(probe);
  if (!ignored) return t.skip('git is not available');
  assert.deepEqual(probe.filter((p) => ignored.has(p)), probe.slice(0, 6));
  for (const p of probe) assert.equal(PUBLIC_TREE_EXCLUDED.test(p), ignored.has(p), p);
});

test('public-tree guard: no published file holds a home path, a Gmail address, the operator\'s handle or name, the personal GitHub account or a Google API key', (t) => {
  const files = repoFiles();
  const ignored = files && ignoredByRootGitignore(files);
  if (!files || !ignored) return t.skip('git is not available');
  // a tracked file that .gitignore skips must be one the plan leaves out, or the guard would have a blind spot
  assert.deepEqual([...ignored].filter((f) => !PUBLIC_TREE_EXCLUDED.test(f)), [], 'ignored but published');
  const hits = [];
  let scanned = 0;
  for (const f of files) {
    if (ignored.has(f)) continue;
    const p = join(ROOT, f);
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    const buf = readFileSync(p);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary (images, fonts)
    scanned++;
    hits.push(...publicTreeHits(f, buf.toString('utf8')));
  }
  assert.ok(scanned > 100, `scanned ${scanned} files`);
  assert.deepEqual(hits, [], `not for the public tree:\n${hits.join('\n')}`);
});
