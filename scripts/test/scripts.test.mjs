// node --test scripts/test/   (pure logic of the OPS scripts; no network, no wrangler, no chain)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { expectationSql, parseKind } from '../admin-expect.mjs';
import { BUDGET, checkBundle, classify, dynamicImports, htmlRefs, initialJs, legalPageProblems, staticImports } from '../check-bundle.mjs';
import { placeHashHex } from '../claims-admin.mjs';
import { altProblems, decodeAlt } from '../create-alt.mjs';
import { buildId, selectSteps, STEPS } from '../deploy-devnet.mjs';
import { devVarsText, gitignoreCovers } from '../dev-vars.mjs';
import { CRANK_TARGET, deployerNeed, distinctnessProblems, followUps, MIN_DEPLOYER, optionalSecretProblems, PHRASE, phoneSetup, REQUIRED_MAINNET_SECRETS, TWILIO_SECRETS, windowProblems, workersPlanPrompt } from '../go-mainnet.mjs';
import { configInputProblems } from '../init-config.mjs';
import { b58decode } from '../lib/b58.mjs';
import { ALT_KEY_LIST, ROOT } from '../lib/paths.mjs';
import { readWranglerConfig } from '../lib/wrangler.mjs';
import { moderationSql } from '../moderate.mjs';
import { Checks } from '../lib/log.mjs';
import { checkDevRoute, originOk } from '../smoke.mjs';
import { pendingProposals, responseFor } from '../watchdog.mjs';

const A = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
const B = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
const C = '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt';

test('go-mainnet: Twilio is optional on mainnet (all three or none), never required by the Worker', () => {
  assert.equal(phoneSetup([]), 'call');
  assert.equal(phoneSetup(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SID', 'ALERT_WEBHOOK_URL']), 'none');
  assert.equal(phoneSetup(['TWILIO_AUTH_TOKEN']), 'partial');
  // what stops the deploy: a partial Twilio setup, and no owner-alert channel at all (website-code claims get their
  // human check there, with or without Twilio); no Twilio at all is fine (alert channels: scripts/test/email.test.mjs)
  const NO_ALERTS = ['ALERT_WEBHOOK_URL', 'ALERT_EMAIL_TO'];
  const names = (missing) => optionalSecretProblems(missing).map((p) => p.name);
  assert.deepEqual(names([...TWILIO_SECRETS]), []);
  assert.deepEqual(names([]), []);
  assert.deepEqual(names(['TWILIO_AUTH_TOKEN']), ['phone verification']);
  assert.match(optionalSecretProblems(['TWILIO_AUTH_TOKEN'])[0].detail, /TWILIO_AUTH_TOKEN missing/);
  assert.deepEqual(names([...TWILIO_SECRETS, ...NO_ALERTS]), ['owner alerts']);
  assert.deepEqual(names(NO_ALERTS), ['owner alerts']);
  assert.deepEqual(names(['TWILIO_VERIFY_SID', ...NO_ALERTS]), ['phone verification', 'owner alerts']);
  for (const n of TWILIO_SECRETS) assert.ok(!REQUIRED_MAINNET_SECRETS.includes(n), n);
  // wrangler refuses to deploy while a `secrets.required` name is unset: Twilio must not be listed there
  const required = JSON.stringify(readWranglerConfig().env.mainnet.secrets.required);
  assert.ok(!/TWILIO/.test(required), required);
  assert.ok(!/TURNSTILE/.test(required), required); // only the phone call step uses it
  assert.ok(!REQUIRED_MAINNET_SECRETS.includes('TURNSTILE_SECRET_KEY'));
  assert.match(workersPlanPrompt('1'), /Workers Paid/);
  assert.match(workersPlanPrompt(undefined), /Workers Paid/);
  assert.match(workersPlanPrompt('0'), /Workers Free.*POLICY_REFERENCE "0"/);
});

test('go-mainnet: phrase, distinct keys, window rules, deployer floor', () => {
  assert.equal(PHRASE, 'DEPLOY ATLASPAD TO MAINNET');
  assert.deepEqual(distinctnessProblems({ attestor: A, guardian: B, governance: C, deployer: null }), []);
  assert.match(distinctnessProblems({ attestor: A, guardian: A, governance: C })[0], /attestor and guardian are the same key/);
  assert.deepEqual(windowProblems(259_200, 43_200), []);
  assert.ok(windowProblems(259_199).some((p) => /72 h/.test(p)));
  assert.ok(windowProblems(2_592_001).some((p) => /30 d/.test(p)));
  assert.ok(windowProblems(259_200, 172_800).some((p) => /time lock/.test(p))); // 72 h ≤ 48 h + 24 h
  assert.deepEqual(windowProblems(259_200, 172_799), []);
  assert.equal(deployerNeed({ programPeak: 0n, configRent: 0n, altRent: 0n, crankTopUp: 0n }), MIN_DEPLOYER);
  assert.equal(deployerNeed({ programPeak: 700_000_000n, configRent: 2_000_000n, altRent: 3_000_000n, crankTopUp: 50_000_000n }), 775_000_000n);
});

test('go-mainnet: the 0.59 SOL floor covers the deploy with the 0.1 SOL crank top-up and room to spare', () => {
  assert.equal(CRANK_TARGET, 100_000_000n);
  assert.equal(MIN_DEPLOYER, 590_000_000n);
  // the 35,928 B mainnet artifact at mainnet rent (getMinimumBalanceForRentExemption, 2026-10-27): ProgramData
  // 183,393,080 + program account 833,120 + buffer 183,352,440 + write fees 230,000; Config 1,950,720; ALT 3,210,560
  const programPeak = 183_393_080n + 833_120n + 183_352_440n + 230_000n;
  const parts = { programPeak, configRent: 1_950_720n, altRent: 3_210_560n, crankTopUp: CRANK_TARGET };
  assert.equal(deployerNeed(parts), MIN_DEPLOYER, 'the floor, not the computed need, is what the deployer must hold');
  const computed = programPeak + parts.configRent + parts.altRent + CRANK_TARGET + 20_000_000n; // deployerNeed's sum
  assert.ok(computed < 500_000_000n, `computed need ${computed}`);
  assert.ok(MIN_DEPLOYER - computed >= 90_000_000n, 'at least 0.09 SOL spare under the floor');
});

test('go-mainnet E10: commit the mainnet record first, then the claim path that matches the phone setup', () => {
  const base = { squadsAVault: 'AVAULT', squadsBVault: 'BVAULT', guardian: 'GUARD' };
  const off = followUps({ ...base, phone: 'none', windowSecs: 259_200 });
  assert.match(off[0], /^Commit and push the mainnet record: git add deploy\/mainnet\.json wrangler\.jsonc && git commit -m "mainnet live" && git push/);
  assert.match(off[0], /run the Watchdog \(mainnet\) workflow once .* no longer says "nothing to watch"/s);
  const launch = off.find((t) => /^Launch one coin/.test(t));
  assert.match(launch, /claim it with the code on your own website \(phone checks are off\); withdraw after the 72 h claim window ends/);
  assert.ok(!off.some((t) => /phone call/.test(t)), 'no phone call when phone checks are off');
  const call = followUps({ ...base, phone: 'call' });
  assert.match(call.find((t) => /^Launch one coin/.test(t)), /claim it with the real phone call; withdraw after the 72 h claim window ends/);
  assert.ok(off.some((t) => t.includes('accept_governance') && t.includes('AVAULT')));
  assert.ok(off.some((t) => t.includes('--new-upgrade-authority BVAULT')));
  assert.ok(off.some((t) => t.includes('guardian (GUARD)') && t.includes('scripts/guardian.mjs')));
});

test('MAINNET-CHECKLIST §8: push deploy/mainnet.json so the GitHub watchdog starts watching', () => {
  const md = readFileSync(join(ROOT, 'MAINNET-CHECKLIST.md'), 'utf8');
  const s8 = md.slice(md.indexOf('## 8. Monitoring'));
  assert.ok(s8.includes('git add deploy/mainnet.json wrangler.jsonc && git commit -m "mainnet live" && git push'));
  assert.match(s8, /\*\*Watchdog \(mainnet\)\*\* workflow once and check it no longer says "nothing to watch"/);
  // the workflow really stays idle until the record with the ALT is on GitHub
  assert.match(readFileSync(join(ROOT, '.github', 'workflows', 'watchdog.yml'), 'utf8'), /nothing to watch/);
  assert.match(md, /About \*\*0\.29 SOL stays locked\*\*: .* 0\.1 SOL for the fee crank/s);
});

test('init-config input rules (SPEC I10, D10)', () => {
  assert.deepEqual(configInputProblems({ cluster: 'devnet', attestor: A, governance: B, guardian: C, windowSecs: 60 }), []);
  assert.ok(configInputProblems({ cluster: 'devnet', attestor: A, governance: A, guardian: C, windowSecs: 60 }).some((p) => /three different keys/.test(p)));
  assert.ok(configInputProblems({ cluster: 'devnet', attestor: A, governance: B, guardian: C, windowSecs: 259_200 }).some((p) => /outside/.test(p)));
  assert.ok(configInputProblems({ cluster: 'mainnet', attestor: A, governance: B, guardian: C, windowSecs: 60 }).some((p) => /outside/.test(p)));
  assert.deepEqual(configInputProblems({ cluster: 'mainnet', attestor: A, governance: B, guardian: C, windowSecs: 259_200 }), []);
});

function altBytes(keys, { authority = null, deactivated = false } = {}) {
  const head = Buffer.alloc(56);
  head.writeUInt32LE(1, 0);
  head.writeBigUInt64LE(deactivated ? 5n : 0xffffffffffffffffn, 4);
  head.writeBigUInt64LE(123n, 12);
  if (authority) {
    head[21] = 1;
    Buffer.from(b58decode(authority)).copy(head, 22);
  }
  return Buffer.concat([head, ...keys.map((k) => Buffer.from(b58decode(k)))]);
}

test('ALT decoding and the frozen-content rule', () => {
  const good = decodeAlt(altBytes(ALT_KEY_LIST));
  assert.equal(good.addresses.length, 14);
  assert.deepEqual(altProblems(good), []);
  assert.ok(altProblems(decodeAlt(altBytes(ALT_KEY_LIST, { authority: A }))).some((p) => /not frozen/.test(p)));
  assert.deepEqual(altProblems(decodeAlt(altBytes(ALT_KEY_LIST, { authority: A })), { requireFrozen: false }), []);
  const swapped = [...ALT_KEY_LIST];
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.ok(altProblems(decodeAlt(altBytes(swapped))).some((p) => /key #0/.test(p)));
  assert.ok(altProblems(decodeAlt(altBytes(ALT_KEY_LIST.slice(0, 13)))).some((p) => /holds 13 keys/.test(p)));
  assert.ok(altProblems(decodeAlt(altBytes(ALT_KEY_LIST, { deactivated: true }))).some((p) => /deactivated/.test(p)));
  assert.throws(() => decodeAlt(Buffer.alloc(10)), /not an address lookup table/);
});

test('deploy-devnet step selection and build id', () => {
  assert.deepEqual(selectSteps({}), STEPS);
  assert.ok(STEPS.indexOf('secrets') < STEPS.indexOf('deploy'), 'secrets must precede deploy (secrets.required)');
  assert.deepEqual(selectSteps({ only: 'deploy,smoke' }), ['preflight', 'deploy', 'smoke']);
  assert.deepEqual(selectSteps({ from: 'build' }), ['preflight', 'build', 'secrets', 'deploy', 'smoke']);
  assert.ok(!selectSteps({ skip: 'roles' }).includes('roles'));
  assert.throws(() => selectSteps({ only: 'nuke' }), /unknown step/);
  assert.match(buildId('/nonexistent'), /^\d{12}-[0-9a-f]{8}$/);
});

test('moderation SQL only takes validated values (no injection)', () => {
  assert.match(moderationSql('hide', A, 1000), /status = 'hidden', updated_at = 1000 WHERE mint = '4wTV/);
  assert.match(moderationSql('unhide', A), /status = 'live'/);
  assert.match(moderationSql('optout', 'ChIJN1t_tDeuEmsRUsoyG83frY4'), /WHERE place_id = 'ChIJN1t_tDeuEmsRUsoyG83frY4'/);
  assert.match(moderationSql('optout', 'cornershop-test:cafe-1'), /cornershop-test:cafe-1/);
  // an opt-out is recorded for the place itself (launches refused even before a coin exists) and hides its coin
  assert.match(moderationSql('optout', 'ChIJN1t_tDeuEmsRUsoyG83frY4', 7), /^INSERT OR IGNORE INTO place_optouts\(place_id, created_at\) VALUES \('ChIJN1t_tDeuEmsRUsoyG83frY4', 7\); UPDATE coins SET status = 'hidden'/);
  assert.equal(moderationSql('optin', 'ChIJN1t_tDeuEmsRUsoyG83frY4'), "DELETE FROM place_optouts WHERE place_id = 'ChIJN1t_tDeuEmsRUsoyG83frY4'");
  assert.throws(() => moderationSql('optin', "x'); DROP TABLE coins;--"), /place id/);
  assert.throws(() => moderationSql('hide', "x' OR '1'='1"), /base58/);
  assert.throws(() => moderationSql('optout', "ChIJ'; DELETE FROM coins;--"), /place id/);
  assert.throws(() => moderationSql('drop', A), /unknown action/);
});

test('admin expectations: kinds and validation', () => {
  assert.equal(parseKind('attestor-proposed'), 1);
  assert.equal(parseKind('4'), 4);
  assert.throws(() => parseKind('nope'), /unknown kind/);
  assert.match(expectationSql({ kind: 1, key: A, note: 'routine rotation (Q4)', now: 5 }), /VALUES \(1, '4wTV.*', 'routine rotation \(Q4\)', 5\)/);
  assert.throws(() => expectationSql({ kind: 1, key: A, note: "it's" }), /note/);
  assert.throws(() => expectationSql({ kind: 12, key: A }), /0\.\.9/);
  assert.throws(() => expectationSql({ kind: 1, key: 'zzz' }), /base58/);
});

test('claims-admin place hash = SPEC test vector', () => {
  assert.equal(placeHashHex('ChIJN1t_tDeuEmsRUsoyG83frY4'), '52791f4bf8f035bc928405e161a4c28a262db717cfe91ae8d3615563066afa15');
});

test('dev-vars: gitignore coverage and dotenv serialisation', () => {
  assert.equal(gitignoreCovers('.dev.vars.devnet', '.env*\n.dev.vars*\n'), true);
  assert.equal(gitignoreCovers('.dev.vars.devnet', '.env*\n!.dev.vars.devnet\n'), false);
  assert.equal(gitignoreCovers('.dev.vars.devnet', 'node_modules\n'), false);
  assert.equal(devVarsText({ A: 'abc+/=', B: 'has space' }), 'A=abc+/=\nB="has space"\n');
  assert.throws(() => devVarsText({ A: 'x\ny' }), /newline/);
});

test('smoke: /api/dev/airdrop is a 404 on mainnet (not_found: no dev route), present on devnet', () => {
  const run = (cluster, status, error) => {
    const checks = new Checks();
    checkDevRoute({ res: { status, json: error ? { error } : null }, cluster, checks });
    return checks.failed.length === 0;
  };
  assert.equal(run('mainnet', 404, 'not_found'), true, 'what the mainnet Worker answers (worker/api.ts)');
  assert.equal(run('mainnet', 404, 'not_enabled'), true);
  assert.equal(run('mainnet', 404, 'other'), false);
  assert.equal(run('mainnet', 400, 'bad_request'), false, 'a reachable dev route on mainnet fails');
  assert.equal(run('mainnet', 503, 'faucet_empty'), false);
  assert.equal(run('devnet', 400, 'bad_request'), true);
  assert.equal(run('devnet', 404, 'not_found'), false);
});

test('smoke only targets our Workers or a local wrangler dev', () => {
  assert.equal(originOk('https://cornershop-devnet.tiejiucai.workers.dev'), true);
  assert.equal(originOk('http://127.0.0.1:8787'), true);
  assert.equal(originOk('http://example.com'), false);
  assert.equal(originOk('https://cornershop-devnet.tiejiucai.workers.dev/api?x=1'), false);
});

test('watchdog: pending proposals and the response a human must take', () => {
  const pk = (s) => ({ toBase58: () => s });
  const cfg = { pendingAttestor: pk(A), pendingAttestorEta: 1_800_000_000n, attestorProposalEscalated: false, pendingGuardian: null, pendingGovernance: pk(B), pendingGovernanceEta: 1_800_000_000n, pendingGovernanceByGuardian: true };
  const p = pendingProposals(cfg);
  assert.deepEqual(p.map((x) => x.kind), [1, 4]);
  assert.match(responseFor(p[0]), /guardian must veto: cancel_attestor_proposal/);
  assert.match(responseFor(p[1]), /governance must withdraw/);
  assert.match(responseFor({ ...p[0], escalated: true }), /can no longer veto/);
});

test('check-bundle: static vs dynamic imports, html refs, initial set, fingerprints', async () => {
  const code = 'import{a as b}from"./chunk-a.js";import"./side.js";export*from"../x/re.js";const m=import(`./lazy.js`);import("./lazy2.js");const s="from \\"https://cdn/x.js\\"";';
  assert.deepEqual(staticImports(code).sort(), ['../x/re.js', './chunk-a.js', './side.js']);
  assert.deepEqual(dynamicImports(code).sort(), ['./lazy.js', './lazy2.js']);
  const html = '<script type="module" crossorigin src="/assets/index-1.js"></script><link rel="modulepreload" href="/assets/vendor.js"><link rel="stylesheet" href="/assets/index.css"><link href="https://fonts.googleapis.com/css" rel="stylesheet">';
  assert.deepEqual(htmlRefs(html), { scripts: ['assets/index-1.js', 'assets/vendor.js'], css: ['assets/index.css'] });

  const dist = mkdtempSync(join(tmpdir(), 'cs-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<html><div id="root"></div><script type="module" src="/assets/index.js"></script><link rel="stylesheet" href="/assets/index.css"></html>');
  writeFileSync(join(dist, 'assets', 'index.js'), 'import{x}from"./core.js";const t=()=>import(`./pump.js`);const w=()=>import(`./wallet.js`);');
  writeFileSync(join(dist, 'assets', 'core.js'), 'export const x=1;');
  writeFileSync(join(dist, 'assets', 'pump.js'), '"buy_exact_quote_in_v3" "bonding_curve"');
  writeFileSync(join(dist, 'assets', 'wallet.js'), 'const m="cs-devnet-test-wallet-v1";fetch("/api/dev/airdrop")');
  writeFileSync(join(dist, 'assets', 'index.css'), 'body{}');
  assert.deepEqual(initialJs(dist, ['assets/index.js']).sort(), ['assets/core.js', 'assets/index.js']);
  assert.equal(classify('"buy_exact_quote_in_v3","bonding_curve"').pumpSdk, true);
  assert.equal(classify('x').pumpSdk, false);

  const dev = await checkBundle({ dist, cluster: 'devnet' });
  assert.equal(dev.checks.failed.length, 0, JSON.stringify(dev.checks.failed));
  const main = await checkBundle({ dist, cluster: 'mainnet' });
  assert.ok(main.checks.failed.some((f) => /devnet-only marker/.test(f.what)), 'mainnet must fail on the test wallet chunk');

  writeFileSync(join(dist, 'assets', 'core.js'), 'export const x="https://solana-mainnet.g.alchemy.com/v2/abc";const n="ATTESTOR_SECRET";');
  const leak = await checkBundle({ dist, cluster: 'devnet' });
  assert.ok(leak.checks.failed.some((f) => /provider URL/.test(f.what)));
  assert.ok(leak.checks.failed.some((f) => /server secret name/.test(f.what)));

  writeFileSync(join(dist, 'assets', 'core.js'), `export const x="${'a'.repeat(10)}";` + 'import"./pump.js";');
  const eager = await checkBundle({ dist, cluster: 'devnet' });
  assert.ok(eager.checks.failed.some((f) => /pump SDK not on the initial path/.test(f.what)));
  assert.ok(BUDGET.initialJsGz === 170 * 1024);
});

test('check-bundle: a mainnet build fails while Terms / Privacy still read like the prototype', async () => {
  assert.deepEqual(legalPageProblems('<p>Memecoins can go to zero.</p><!-- old: prototype -->'), []);
  assert.deepEqual(legalPageProblems('<p class="note">AtlasPad is a <b>prototype</b>. Trades are simulated.</p>'), ['prototype', 'simulated']);
  assert.deepEqual(legalPageProblems('No real transaction is ever sent and you are never asked to sign anything.'), ['No real transaction', 'never asked to sign']);
  // the pages we ship are written for real money
  for (const page of ['terms.html', 'privacy.html']) assert.deepEqual(legalPageProblems(readFileSync(join(ROOT, 'public', page), 'utf8')), [], page);

  const dist = mkdtempSync(join(tmpdir(), 'cs-legal-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<html><script type="module" src="/assets/index.js"></script></html>');
  writeFileSync(join(dist, 'assets', 'index.js'), 'export const x=1;');
  const legal = (r) => r.checks.failed.filter((f) => /terms|privacy/.test(f.what)).map((f) => f.what);
  assert.deepEqual(legal(await checkBundle({ dist, cluster: 'mainnet' })), ['terms.html missing', 'privacy.html missing']);
  writeFileSync(join(dist, 'terms.html'), '<p>AtlasPad is a prototype. Prices are simulated.</p>');
  writeFileSync(join(dist, 'privacy.html'), '<p>UK GDPR controller: AtlasPad.</p>');
  assert.deepEqual(legal(await checkBundle({ dist, cluster: 'mainnet' })), ['prototype wording in terms.html']);
  assert.deepEqual(legal(await checkBundle({ dist, cluster: 'devnet' })), [], 'devnet builds are not held to it');
  writeFileSync(join(dist, 'terms.html'), '<p>Real money. Transactions are irreversible.</p>');
  assert.deepEqual(legal(await checkBundle({ dist, cluster: 'mainnet' })), []);
});

test('go-mainnet: SOL parked in a resumable upload buffer counts only when the buffer is the deployer\'s', async () => {
  const { parkedBufferLamports, DEPLOY_SIGN_ATTEMPTS } = await import('../go-mainnet.mjs');
  const { b58decode } = await import('../lib/b58.mjs');
  const DEPLOYER = '6bTRiMFUuVkzrMmX5pWWVHoXyJWHEkztMeNKNs4DfFc1';
  const OTHER = '89cqm2c25K8kPpEKtsaXnMNLfh8ELgN1Zt9ZHW92WibV';
  const buffer = (authority, tag = 1) => {
    const d = Buffer.alloc(37 + 100);
    d.writeUInt32LE(tag, 0);
    if (authority) { d[4] = 1; Buffer.from(b58decode(authority)).copy(d, 5); }
    return d;
  };
  const acc = (data, owner = 'BPFLoaderUpgradeab1e11111111111111111111111') => ({ lamports: 183_393_080n, owner, executable: false, data });
  assert.equal(parkedBufferLamports(acc(buffer(DEPLOYER)), DEPLOYER), 183_393_080n);
  assert.equal(parkedBufferLamports(acc(buffer(OTHER)), DEPLOYER), 0n);
  assert.equal(parkedBufferLamports(acc(buffer(null)), DEPLOYER), 0n);
  assert.equal(parkedBufferLamports(acc(buffer(DEPLOYER, 2)), DEPLOYER), 0n);
  assert.equal(parkedBufferLamports(acc(buffer(DEPLOYER), '11111111111111111111111111111111'), DEPLOYER), 0n);
  assert.equal(parkedBufferLamports(null, DEPLOYER), 0n);
  assert.ok(DEPLOY_SIGN_ATTEMPTS >= 50);
});

test('go-mainnet: a resumed launch (program already deployed) needs only what is left, without the 0.59 SOL floor', () => {
  const left = deployerNeed({ programPeak: 0n, configRent: 1_950_720n, altRent: 3_210_560n, crankTopUp: 100_000_000n, floor: 0n });
  assert.equal(left, 1_950_720n + 3_210_560n + 100_000_000n + 20_000_000n);
  assert.equal(deployerNeed({ programPeak: 0n, configRent: 0n, altRent: 0n, crankTopUp: 0n }), MIN_DEPLOYER);
});

test('wrangler.jsonc: each D1 placeholder appears at most once (as its database_id), so go-mainnet E5 can fill it', async () => {
  const { D1_PLACEHOLDERS } = await import('../lib/paths.mjs');
  const text = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  for (const token of Object.values(D1_PLACEHOLDERS)) assert.ok(text.split(token).length - 1 <= 1, `${token} appears more than once`);
});
