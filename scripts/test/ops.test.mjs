// node --test scripts/test/   (ops automation: watchdog alerts + expected state, devnet evidence freshness, the CI
// verified build, the mainnet hotfix vars plan). Pure logic and fabricated fixtures only: no network, no wrangler.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { currentVersionId, DEPLOY_JSON_VARS, liveVarsOf, planVars, unknownLiveState, varFlags } from '../deploy-mainnet-hotfix.mjs';
import { alertDecision, alertText, findingsDigest, postAlert, webhookBody, webhookUrl } from '../lib/alert.mjs';
import { DEVNET_GRADUATION_POOL, graduationWaiver, isDeployRecord, latestDevnetDeploy, reportTime, staleReason, stampFromName } from '../lib/evidence.mjs';
import { assessAuthorities, assessProposal, criticalFindings, exitCodeOf, expectedState } from '../lib/expected.mjs';
import { Checks } from '../lib/log.mjs';
import { ROOT } from '../lib/paths.mjs';
import { PROGRAM_SOURCE_PATHS, readVerifiedArtifact, sourceDriftProblems, verifiedArtifactProblems } from '../lib/verifiedBuild.mjs';
import { afterSend, ALERTS_WINDOW, alertsQuery, CRANK_CRITICAL, CRANK_WARN, crankFinding, GUARDIAN_WARN, guardianFinding, loopAlert, reportAlerts } from '../watchdog.mjs';

const DEPLOYER = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
const SQUADS_A = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
const SQUADS_B = '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt';
const ATTESTOR = '13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ';
const GUARDIAN = 'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s';
const ATTACKER = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
const ALT = 'AcC53qbWCpZUsSXjaN36h35KyqQQH37oreFnrbZBtB6G';
const PROGRAM = '6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x';
const HOOK = 'https://discord.com/api/webhooks/123/abc-token';

// go-mainnet writes governance = upgradeAuthority = deployer (E1/E4) and the Squads vaults (E4) into deploy/mainnet.json.
const MAINNET_DEP = { attestor: ATTESTOR, guardian: GUARDIAN, governance: DEPLOYER, upgradeAuthority: DEPLOYER, squadsAVault: SQUADS_A, squadsBVault: SQUADS_B, programDataSha256: 'ab'.repeat(32) };
const cfg = (governance, over = {}) => ({ attestor: ATTESTOR, guardian: GUARDIAN, governance, ...over });
const assess = (governance, upgradeAuthority, { over, dep = MAINNET_DEP, cluster = 'mainnet', exists = true } = {}) =>
  assessAuthorities({ cluster, config: cfg(governance, over), program: { exists, upgradeAuthority }, expected: expectedState(dep) });

test('expected state: the planned Squads A/B handover is never critical, before or after', () => {
  const before = assess(DEPLOYER, DEPLOYER);
  assert.equal(exitCodeOf(before), 1);
  assert.deepEqual(criticalFindings(before), []);
  assert.ok(before.some((f) => f.status === 'warn' && /governance not yet Squads vault A/.test(f.what)));
  assert.ok(before.some((f) => f.status === 'warn' && /upgrade authority not yet Squads vault B/.test(f.what)));

  const halfway = assess(SQUADS_A, DEPLOYER); // governance accepted, upgrade authority not moved yet
  assert.deepEqual(criticalFindings(halfway), []);
  const after = assess(SQUADS_A, SQUADS_B);
  assert.equal(exitCodeOf(after), 0);
  assert.ok(after.some((f) => f.what === 'Config.governance' && /Squads vault A/.test(f.detail)));
  assert.ok(after.some((f) => f.what === 'upgrade authority' && /Squads vault B/.test(f.detail)));
  assert.equal(exitCodeOf(assess(SQUADS_A, null)), 0, 'immutable after --final');
  for (const f of after) assert.ok(['attestor', 'guardian', 'governance', 'upgradeAuthority'].includes(f.role));
});

test('expected state: any other authority change is CRITICAL', () => {
  const gov = assess(ATTACKER, SQUADS_B);
  assert.equal(exitCodeOf(gov), 2);
  assert.match(criticalFindings(gov)[0].what, /CRITICAL Config.governance changed/);
  assert.match(criticalFindings(assess(SQUADS_A, ATTACKER))[0].what, /CRITICAL upgrade authority changed/);
  assert.match(criticalFindings(assess(SQUADS_A, SQUADS_A))[0].what, /upgrade authority changed/, 'vault A is not a planned upgrade authority');
  assert.match(criticalFindings(assess(SQUADS_B, SQUADS_B))[0].what, /governance changed/, 'vault B is not a planned governance');
  assert.match(criticalFindings(assess(SQUADS_A, SQUADS_B, { over: { attestor: ATTACKER } }))[0].what, /CRITICAL Config.attestor changed/);
  assert.match(criticalFindings(assess(SQUADS_A, SQUADS_B, { over: { guardian: ATTACKER } }))[0].what, /CRITICAL Config.guardian changed/);
  assert.match(criticalFindings(assess(SQUADS_A, null, { exists: false }))[0].what, /CRITICAL program missing/);
  assert.equal(exitCodeOf(assess(SQUADS_A, null, { exists: false, dep: { ...MAINNET_DEP, programDataSha256: undefined } })), 1, 'not deployed yet is not an attack');
});

test('expected state: devnet (no Squads) and unrecorded roles', () => {
  const dev = { attestor: ATTESTOR, guardian: GUARDIAN, governance: DEPLOYER, upgradeAuthority: DEPLOYER };
  assert.equal(exitCodeOf(assess(DEPLOYER, DEPLOYER, { dep: dev, cluster: 'devnet' })), 0);
  assert.equal(exitCodeOf(assess(ATTACKER, DEPLOYER, { dep: dev, cluster: 'devnet' })), 2);
  const none = assess(DEPLOYER, DEPLOYER, { dep: {}, cluster: 'devnet' });
  assert.equal(exitCodeOf(none), 1);
  assert.deepEqual(criticalFindings(none), []);
  assert.deepEqual(expectedState({ governance: DEPLOYER, squadsAVault: DEPLOYER }).governance, [DEPLOYER]);
});

test('expected state: the pending Squads A handover proposal is planned even without D1', () => {
  const expected = expectedState(MAINNET_DEP);
  assert.deepEqual(assessProposal({ kind: 4, key: SQUADS_A, byGuardian: false }, { expected, registered: false }), { status: 'warn', planned: true });
  assert.equal(assessProposal({ kind: 4, key: SQUADS_A, byGuardian: true }, { expected, registered: false }).planned, false, 'a guardian recovery is never implicitly planned');
  assert.equal(assessProposal({ kind: 4, key: ATTACKER }, { expected, registered: false }).planned, false);
  assert.equal(assessProposal({ kind: 1, key: ATTACKER }, { expected, registered: true }).planned, true, 'registered in admin_expectations');
  assert.equal(assessProposal({ kind: 1, key: SQUADS_A }, { expected, registered: false }).planned, false, 'only governance proposals are implied');
});

test('watchdog --loop: critical posts at once, repeats hourly, resolves, survives flaky runs', () => {
  const crit = [{ status: 'fail', what: 'CRITICAL unregistered attestor rotation', detail: `${ATTACKER} · eta x (40.0 h) → guardian must veto` }];
  const crit2 = [{ ...crit[0], detail: `${ATTACKER} · eta x (39.5 h) → guardian must veto` }];
  let s = { last: null, errors: 0 };
  let r = loopAlert(s, { items: [{ status: 'ok', what: 'fine' }] }, 0);
  assert.equal(r.post, null);
  r = loopAlert(r.state, { items: crit }, 1_000);
  assert.equal(r.post.kind, 'critical');
  assert.equal(r.post.findings.length, 1);
  s = r.state;
  r = loopAlert(s, { items: crit2 }, 1_000 + 30 * 60_000);
  assert.equal(r.post, null, 'the same finding (only the countdown moved) is not re-posted within the hour');
  r = loopAlert(r.state, { items: crit2 }, 1_000 + 61 * 60_000);
  assert.equal(r.post?.kind, 'critical', 'hourly reminder while it lasts');
  r = loopAlert(r.state, { items: [...crit2, { status: 'fail', what: 'CRITICAL alert', detail: 'new' }] }, 1_000 + 62 * 60_000);
  assert.equal(r.post?.kind, 'critical', 'a new finding posts at once');
  r = loopAlert(r.state, { items: [{ status: 'warn', what: 'probation active' }] }, 1_000 + 63 * 60_000);
  assert.equal(r.post?.kind, 'resolved');
  r = loopAlert(r.state, { items: [] }, 1_000 + 64 * 60_000);
  assert.equal(r.post, null, 'resolved is posted once');

  s = { last: null, errors: 0 };
  for (let i = 1; i <= 2; i++) {
    r = loopAlert(s, { error: 'getGenesisHash: HTTP 429' }, i);
    assert.equal(r.post, null, `run failure ${i} is not an incident yet`);
    s = r.state;
  }
  r = loopAlert(s, { error: 'getGenesisHash: network error' }, 3);
  assert.match(r.post.findings[0].what, /CRITICAL watchdog cannot run/);
  r = loopAlert(r.state, { error: 'timeout' }, 4);
  assert.equal(r.post, null, 'a different error message is the same incident');
  r = loopAlert(r.state, { items: [] }, 5);
  assert.equal(r.post?.kind, 'resolved');
  assert.equal(r.state.errors, 0);
});

test('watchdog --loop: an alert that was not delivered is retried on the next run', () => {
  const crit = [{ status: 'fail', what: 'CRITICAL upgrade authority changed', detail: ATTACKER }];
  const s0 = { last: null, errors: 0 };
  const step = loopAlert(s0, { items: crit }, 1_000);
  assert.equal(step.post?.kind, 'critical');
  const failed = afterSend(s0, step, false); // webhook down / 4xx / not set
  assert.equal(failed.last, null);
  const retry = loopAlert(failed, { items: crit }, 1_000 + 5 * 60_000);
  assert.equal(retry.post?.kind, 'critical', 'posted again 5 minutes later, not an hour later');
  const delivered = afterSend(failed, retry, true);
  assert.equal(loopAlert(delivered, { items: crit }, 1_000 + 10 * 60_000).post, null, 'delivered: the hourly rule applies');
  // A RESOLVED message that was not delivered is retried too (the last delivered post is still the critical one).
  const res = loopAlert(delivered, { items: [] }, 1_000 + 11 * 60_000);
  assert.equal(res.post?.kind, 'resolved');
  assert.equal(loopAlert(afterSend(delivered, res, false), { items: [] }, 1_000 + 12 * 60_000).post?.kind, 'resolved');
});

test('watchdog: the crank balance warns below 0.02 SOL and is CRITICAL (exit 2, GitHub email) below 0.005 SOL', () => {
  const CRANK = ATTACKER;
  assert.equal(CRANK_WARN, 20_000_000n);
  assert.equal(CRANK_CRITICAL, 5_000_000n);
  const ok = crankFinding(CRANK, 100_000_000n);
  assert.equal(ok.status, 'ok');
  assert.match(ok.detail, /0\.1000 SOL/);
  const low = crankFinding(CRANK, 19_999_999n);
  assert.equal(low.status, 'warn');
  assert.match(low.detail, new RegExp(`send ≈0\\.1 SOL to ${CRANK}`));
  assert.equal(crankFinding(CRANK, 20_000_000n).status, 'ok');
  const empty = crankFinding(CRANK, 4_999_999n);
  assert.equal(empty.status, 'fail');
  assert.equal(empty.what, 'CRITICAL crank nearly empty');
  assert.equal(crankFinding(CRANK, 5_000_000n).status, 'warn');
  assert.equal(exitCodeOf([empty]), 2, 'a nearly empty crank fails the GitHub run');
  assert.deepEqual(criticalFindings([ok, low, empty]).map((f) => f.what), ['CRITICAL crank nearly empty']);
  assert.equal(exitCodeOf([low]), 1);
  // no crank recorded: a warning, never a silent pass
  assert.equal(crankFinding(undefined, 0n).status, 'warn');
});

test('alerts: webhook URL, body shape, text, digest and decision', () => {
  assert.equal(webhookUrl({ ALERT_WEBHOOK_URL: ` ${HOOK} ` }, undefined), HOOK);
  assert.equal(webhookUrl({ ALERT_WEBHOOK_URL: 'http://insecure.example/x' }, undefined), null);
  assert.equal(webhookUrl({}, undefined), null);
  assert.equal(webhookUrl({}, HOOK), HOOK, '.env.server fallback');
  assert.deepEqual(webhookBody(HOOK, 'x @everyone'), { content: 'x @everyone', allowed_mentions: { parse: [] } }, 'Discord: quoted text never pings');
  assert.deepEqual(Object.keys(webhookBody('https://hooks.slack.com/services/T/B/x', 'x')), ['text']);
  assert.deepEqual(Object.keys(webhookBody('https://acme.slack.com/workflows/x', 'x')), ['text'], 'the same Slack rule as worker webhooks');
  assert.deepEqual(Object.keys(webhookBody('https://evil-slack.com.example/x', 'x')), ['content', 'allowed_mentions']);
  assert.equal(webhookBody(HOOK, 'y'.repeat(5000)).content.length, 1900);
  const text = alertText({ cluster: 'mainnet', findings: Array.from({ length: 10 }, (_, i) => ({ what: `CRITICAL f${i}`, detail: 'd' })) });
  assert.match(text, /^\[AtlasPad watchdog · mainnet\] CRITICAL \(10\)/);
  assert.match(text, /and 2 more/);
  assert.match(alertText({ cluster: 'devnet', findings: [], resolved: true }), /RESOLVED/);
  assert.equal(findingsDigest([]), null);
  assert.equal(findingsDigest([{ what: 'a', detail: 'k (1.0 h)' }, { what: 'b' }]), findingsDigest([{ what: 'b' }, { what: 'a', detail: 'k (-3.5 h)' }]));
  assert.equal(alertDecision(null, null, 0), null);
  assert.equal(alertDecision({ digest: 'x', at: 0 }, 'x', 3_599_999), null);
  assert.equal(alertDecision({ digest: 'x', at: 0 }, 'x', 3_600_000), 'critical');
});

test('alerts: postAlert retries a rate limit once and never throws', async () => {
  const calls = [];
  const fake = (responses) => async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return new Response(r.body ?? null, { status: r.status });
  };
  const noWait = async () => {};
  assert.deepEqual(await postAlert('hi', { url: null }), { sent: false, reason: 'ALERT_WEBHOOK_URL not set' });
  assert.equal((await postAlert('hi', { url: HOOK, fetchImpl: fake([{ status: 204 }]), wait: noWait })).sent, true);
  assert.deepEqual(calls[0].body, { content: 'hi', allowed_mentions: { parse: [] } });
  const waits = [];
  const r429 = await postAlert('hi', { url: HOOK, fetchImpl: fake([{ status: 429, body: '{"retry_after":1.5}' }, { status: 204 }]), wait: async (ms) => void waits.push(ms) });
  assert.equal(r429.sent, true);
  assert.deepEqual(waits, [1500]);
  assert.deepEqual(await postAlert('hi', { url: HOOK, fetchImpl: fake([{ status: 404 }]), wait: noWait }), { sent: false, status: 404, reason: 'HTTP 404' });
  assert.equal((await postAlert('hi', { url: HOOK, fetchImpl: fake([new Error('down'), new Error('down')]), wait: noWait })).sent, false);
  assert.equal((await postAlert('hi', { url: HOOK, fetchImpl: fake([{ status: 502 }, { status: 503 }]), wait: noWait })).status, 503);
});

test('go-mainnet evidence: reports must follow the latest devnet deploy and be ≤ 7 days old', () => {
  assert.equal(stampFromName('e2e-devnet-20261008T221619.json'), Date.UTC(2026, 9, 8, 22, 16, 19));
  assert.equal(stampFromName('nope.json'), null);
  assert.equal(reportTime({ startedAt: '2026-10-08T22:16:19.830Z' }, 'x'), Date.parse('2026-10-08T22:16:19.830Z'));
  assert.equal(reportTime({ at: '2026-10-08T22:11:57.481Z' }, 'x'), Date.parse('2026-10-08T22:11:57.481Z'));
  assert.equal(reportTime({}, 'accuracy-audit-devnet-20261008T221157.json'), Date.UTC(2026, 9, 8, 22, 11, 57));

  assert.equal(isDeployRecord({ execute: true, results: { deploy: { ok: true } } }), true);
  assert.equal(isDeployRecord({ execute: true, results: { program: { deployed: true } } }), true);
  assert.equal(isDeployRecord({ execute: false, results: { deploy: { ok: true } } }), false, 'a dry run deploys nothing');
  assert.equal(isDeployRecord({ execute: true, results: {} }), false, 'e.g. --only record');

  const out = mkdtempSync(join(tmpdir(), 'cs-out-'));
  assert.equal(latestDevnetDeploy(join(out, 'missing')), null);
  const rec = (name, json) => writeFileSync(join(out, name), JSON.stringify(json));
  rec('deploy-devnet-20261009T150530.json', { startedAt: '2026-10-09T15:05:30.000Z', finishedAt: '2026-10-09T15:07:00.000Z', execute: true, results: { deploy: { ok: true } } });
  rec('deploy-devnet-20261025T215157.json', { startedAt: '2026-10-25T21:51:57.000Z', execute: true, results: {} }); // failed run
  rec('deploy-devnet-20261025T215314.json', { startedAt: '2026-10-25T21:53:14.724Z', finishedAt: '2026-10-25T21:54:06.424Z', execute: true, results: { deploy: { ok: true } } });
  rec('deploy-devnet-20261026T090000.json', { startedAt: '2026-10-26T09:00:00.000Z', execute: false, results: {} }); // dry run
  writeFileSync(join(out, 'deploy-devnet-20261026T100000.json'), '{not json');
  const deploy = latestDevnetDeploy(out);
  assert.deepEqual(deploy, { file: 'deploy-devnet-20261025T215314.json', at: Date.parse('2026-10-25T21:54:06.424Z') });

  const now = Date.parse('2026-10-26T12:00:00Z');
  assert.match(staleReason({ at: Date.parse('2026-10-08T22:16:19Z'), deploy, now }), /before the latest devnet deploy deploy-devnet-20261025T215314\.json/);
  assert.match(staleReason({ at: Date.parse('2026-10-25T21:54:00Z'), deploy, now }), /before the latest devnet deploy/, 'started while the deploy was still running');
  assert.equal(staleReason({ at: Date.parse('2026-10-25T22:30:00Z'), deploy, now }), null);
  assert.match(staleReason({ at: Date.parse('2026-10-18T12:00:00Z'), deploy: null, now }), /more than 7 days ago/);
  assert.equal(staleReason({ at: Date.parse('2026-10-19T12:00:01Z'), deploy: null, now }), null);
  assert.match(staleReason({ at: null, deploy, now }), /no run time/);
});

test('go-mainnet --waive-graduation: needs a reason and a pool that still does not exist', () => {
  assert.deepEqual(graduationWaiver(undefined, null), { waiver: null, problems: [] });
  assert.match(graduationWaiver(true, false).problems[0], /reason of at least 10 characters/);
  assert.match(graduationWaiver('too short', false).problems[0], /reason/);
  const ok = graduationWaiver('  pump devnet migration bot never migrated 4MhKxT85  ', false);
  assert.deepEqual(ok, { waiver: { reason: 'pump devnet migration bot never migrated 4MhKxT85', pool: DEVNET_GRADUATION_POOL, poolExists: false }, problems: [] });
  assert.equal(graduationWaiver('pump devnet migration bot is stuck', null).waiver?.poolExists, null, 'RPC down: accepted, recorded as unchecked');
  const exists = graduationWaiver('pump devnet migration bot is stuck', true);
  assert.equal(exists.waiver, null);
  assert.match(exists.problems[0], /exists now: run the graduation test/);
  assert.equal(DEVNET_GRADUATION_POOL, '4MhKxT85ohkLzvSyBeNHRynV5kaX9TLdA3ZdzgYJ29Ez');
});

test('go-mainnet --verified-artifact: the CI solana-verify build replaces the local Docker check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-verified-'));
  const so = Buffer.from('fake ELF shop-vault-build:mainnet');
  const sha = createHash('sha256').update(so).digest('hex');
  assert.ok(verifiedArtifactProblems(readVerifiedArtifact(dir), sha).length >= 3, 'empty dir');
  writeFileSync(join(dir, 'shop_vault.so'), so);
  writeFileSync(join(dir, 'shop_vault.so.sha256'), `${sha}  shop_vault.so\n`);
  writeFileSync(join(dir, 'build-info.json'), JSON.stringify({ flavour: 'mainnet', sha256: sha, commit: 'a'.repeat(40), executableHash: 'e'.repeat(64) }));
  const ci = readVerifiedArtifact(dir);
  assert.deepEqual(verifiedArtifactProblems(ci, sha), []);
  assert.ok(verifiedArtifactProblems(ci, 'f'.repeat(64)).some((p) => /not the CI build/.test(p)));
  assert.ok(verifiedArtifactProblems({ ...ci, info: { ...ci.info, flavour: 'devnet' } }, sha).some((p) => /flavour/.test(p)));
  assert.ok(verifiedArtifactProblems({ ...ci, soSha256: 'f'.repeat(64) }, sha).some((p) => /corrupt/.test(p)));
  assert.ok(verifiedArtifactProblems({ ...ci, info: { ...ci.info, commit: 'main' } }, sha).some((p) => /commit/.test(p)));
});

test('go-mainnet --verified-artifact: the CI build must be of the program source being deployed', async () => {
  const C = 'c'.repeat(40);
  const calls = [];
  const git = (answers) => async (args) => {
    calls.push(args);
    return answers.shift();
  };
  assert.deepEqual(await sourceDriftProblems('main', git([])), [], 'malformed commit: reported by verifiedArtifactProblems');
  assert.deepEqual(await sourceDriftProblems(C, git([{ code: 0, out: '' }, { code: 0, out: '' }])), []);
  assert.deepEqual(calls.at(-1), ['diff', '--name-only', C, '--', ...PROGRAM_SOURCE_PATHS], 'working tree vs that commit, program inputs only');
  assert.ok(PROGRAM_SOURCE_PATHS.includes('programs/shop-vault/src') && PROGRAM_SOURCE_PATHS.includes('programs/shop-vault/Cargo.lock'));
  assert.match((await sourceDriftProblems(C, git([{ code: 128, out: 'fatal' }])))[0], /not in this clone: git fetch/);
  const drift = await sourceDriftProblems(C, git([{ code: 0, out: '' }, { code: 0, out: 'programs/shop-vault/src/a.rs\nprograms/shop-vault/src/b.rs\nprograms/shop-vault/src/c.rs\nprograms/shop-vault/Cargo.toml\n' }]));
  assert.match(drift[0], /differs from the CI build's commit cccccccccccc \(programs\/shop-vault\/src\/a\.rs, .*, …\): run the Verifiable build workflow/);
  assert.match((await sourceDriftProblems(C, git([{ code: 0, out: '' }, { code: 1, out: '' }])))[0], /git diff .* failed/);
});

test('hotfix: the live version is the newest deployment, its largest share', () => {
  const list = [
    { id: 'd1', created_on: '2026-10-25T10:00:00Z', versions: [{ version_id: 'v-old', percentage: 100 }] },
    { id: 'd3', created_on: '2026-10-26T10:00:00Z', versions: [{ version_id: 'v-canary', percentage: 10 }, { version_id: 'v-main', percentage: 90 }] },
    { id: 'd2', created_on: '2026-10-25T12:00:00Z', versions: [{ version_id: 'v-mid', percentage: 100 }] },
  ];
  assert.equal(currentVersionId(list), 'v-main');
  assert.equal(currentVersionId({ deployments: list.slice(0, 1) }), 'v-old');
  assert.equal(currentVersionId([]), null);
  assert.equal(currentVersionId(null), null);
  const live = liveVarsOf({ resources: { bindings: [{ type: 'plain_text', name: 'ALT_ADDRESS', text: ALT }, { type: 'secret_text', name: 'ATTESTOR_SECRET' }, { type: 'json', name: 'J', json: {} }, { type: 'd1', name: 'DB' }] } });
  assert.deepEqual(live, { vars: { ALT_ADDRESS: ALT }, json: ['J'] });
});

test('hotfix: every var is preserved (ALT_ADDRESS and PROGRAM_ID from deploy/mainnet.json)', () => {
  assert.deepEqual(DEPLOY_JSON_VARS, { alt: 'ALT_ADDRESS', programId: 'PROGRAM_ID' });
  const configVars = { CLUSTER: 'mainnet', PUBLIC_ORIGIN: 'https://atlaspad.online', PROGRAM_ID: PROGRAM, ALT_ADDRESS: '', TURNSTILE_SITE_KEY: '0x4AAA', BUILD_ID: '' };
  const deploy = { alt: ALT, programId: PROGRAM };
  const liveVars = { CLUSTER: 'mainnet', PUBLIC_ORIGIN: 'https://cornershop.tiejiucai.workers.dev', PROGRAM_ID: PROGRAM, ALT_ADDRESS: ALT, TURNSTILE_SITE_KEY: '0x4AAA', BUILD_ID: 'old', DASH_ONLY: 'kept:value' };
  const p = planVars({ configVars, deploy, liveVars, buildId: '202610261200-abcdef12' });
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.vars, { ALT_ADDRESS: ALT, PROGRAM_ID: PROGRAM, BUILD_ID: '202610261200-abcdef12', DASH_ONLY: 'kept:value' });
  assert.equal(p.finalVars.ALT_ADDRESS, ALT, 'the empty wrangler.jsonc ALT_ADDRESS never reaches the Worker');
  assert.equal(p.finalVars.CLUSTER, 'mainnet');
  assert.deepEqual(p.kept, ['DASH_ONLY']);
  assert.deepEqual(p.changes, [{ name: 'PUBLIC_ORIGIN', from: 'https://cornershop.tiejiucai.workers.dev', to: 'https://atlaspad.online' }]);
  assert.deepEqual(varFlags(p.vars), ['--var', `ALT_ADDRESS:${ALT}`, '--var', 'BUILD_ID:202610261200-abcdef12', '--var', 'DASH_ONLY:kept:value', '--var', `PROGRAM_ID:${PROGRAM}`]);

  const unread = planVars({ configVars, deploy, liveVars: null, buildId: 'b1' });
  assert.deepEqual(unread.problems, [], 'live vars unreadable: deploy json + wrangler.jsonc still give every var');
  assert.deepEqual(unread.changes, []);
  assert.equal(unread.vars.ALT_ADDRESS, ALT);
});

test('hotfix --execute: refuses while the live version, its vars or the migration status are unknown', () => {
  assert.deepEqual(unknownLiveState({ prevVersion: 'v-main', liveVarsRead: true, migrationsKnown: true }), []);
  assert.match(unknownLiveState({ prevVersion: null, liveVarsRead: false, migrationsKnown: true })[0], /no rollback target/);
  assert.match(unknownLiveState({ prevVersion: 'v-main', liveVarsRead: false, migrationsKnown: true })[0], /v-main could not be read: a var that exists only on the live Worker would be dropped/);
  const both = unknownLiveState({ prevVersion: 'v-main', liveVarsRead: false, migrationsKnown: false });
  assert.equal(both.length, 2);
  assert.match(both[1], /D1 migration status unknown/);
});

test('hotfix: refuses when a var would silently change', () => {
  const configVars = { CLUSTER: 'mainnet', PROGRAM_ID: PROGRAM, ALT_ADDRESS: '', TURNSTILE_SITE_KEY: '' };
  const deploy = { alt: ALT, programId: PROGRAM };
  const has = (p, re) => p.problems.some((x) => re.test(x));
  assert.ok(has(planVars({ configVars, deploy: null, liveVars: null, buildId: 'b' }), /deploy\/mainnet.json has no valid alt/));
  assert.ok(has(planVars({ configVars, deploy: { programId: PROGRAM }, liveVars: null, buildId: 'b' }), /no valid alt \(the Worker's ALT_ADDRESS\)/));
  assert.ok(has(planVars({ configVars, deploy, liveVars: { ALT_ADDRESS: DEPLOYER }, buildId: 'b' }), /live Worker's ALT_ADDRESS is 4wTV/));
  assert.ok(has(planVars({ configVars: { ...configVars, PROGRAM_ID: DEPLOYER }, deploy, liveVars: null, buildId: 'b' }), /wrangler.jsonc env.mainnet.vars.PROGRAM_ID/));
  assert.ok(has(planVars({ configVars, deploy, liveVars: { TURNSTILE_SITE_KEY: '0x4AAA' }, buildId: 'b' }), /TURNSTILE_SITE_KEY is empty but the live Worker has a value/));
  assert.ok(has(planVars({ configVars, deploy, liveVars: {}, liveJsonVars: ['FLAGS'], buildId: 'b' }), /JSON var FLAGS/));
  assert.ok(has(planVars({ configVars, deploy, liveVars: { X: 'a\nb' }, buildId: 'b' }), /newline/));
  assert.ok(has(planVars({ configVars, deploy, liveVars: null, buildId: 'has space' }), /BUILD_ID/));
});

test('watchdog: a guardian that cannot pay fees is a warning, never critical', () => {
  const G = 'Dgvs73gGmomkVz3xrQoshRj7JiRH1eZ2nALiXpV6Usni';
  assert.equal(guardianFinding(G, 10_000_000n).status, 'ok');
  const low = guardianFinding(G, GUARDIAN_WARN - 1n);
  assert.equal(low.status, 'warn');
  assert.match(low.detail, /send it ≈0\.01 SOL/);
  assert.equal(guardianFinding(G, 0n).status, 'warn');
});

/** reportAlerts on fabricated D1 rows: the check items, the exit code and every line it printed. */
function alertRun(t, rows, publicLog) {
  const log = t.mock.method(console, 'log', () => {});
  const checks = new Checks();
  reportAlerts(checks, rows, { publicLog });
  const printed = log.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
  log.mock.restore();
  return { checks, printed, code: exitCodeOf(checks.items) };
}

test('watchdog --public-log: D1 alerts as counts per severity and kind only; the same exit codes', (t) => {
  // the public query never selects a message, ref or time, so none can reach the log; it counts the private window
  assert.equal(ALERTS_WINDOW, 30);
  assert.match(alertsQuery(true), /^SELECT severity, kind, COUNT\(\*\) AS n FROM \(SELECT severity, kind FROM alerts WHERE acked_at IS NULL ORDER BY id DESC LIMIT 30\) GROUP BY severity, kind$/);
  assert.ok(!/message|ref|created_at/.test(alertsQuery(true)));
  assert.match(alertsQuery(false), /^SELECT severity, kind, message, ref, created_at FROM alerts WHERE acked_at IS NULL ORDER BY id DESC LIMIT 30$/);
  assert.equal(alertsQuery(), alertsQuery(false));

  const counts = [
    { severity: 'critical', kind: 'creator_changed', n: 1 },
    { severity: 'critical', kind: 'admin_changed', n: 2 },
    { severity: 'warn', kind: 'sanctioned_wallet', n: 3 },
    { severity: 'info', kind: 'claim_website_verified', n: 4 },
  ];
  const crit = alertRun(t, counts, true);
  assert.equal(crit.code, 2, 'a critical alert still fails the GitHub run (the email)');
  assert.deepEqual(criticalFindings(crit.checks.items).map((f) => f.what), ['CRITICAL alerts: 3']);
  assert.match(crit.printed, /CRITICAL alerts: 3 — admin_changed ×2, creator_changed ×1/);
  assert.match(crit.printed, /warn alerts: 3 — sanctioned_wallet ×3/);
  assert.match(crit.printed, /info alerts: 4 — claim_website_verified ×4/);

  assert.equal(alertRun(t, counts.slice(2), true).code, 1, 'warnings only: exit 1');
  const quiet = alertRun(t, counts.slice(3), true);
  assert.equal(quiet.code, 0, 'info only: exit 0');
  assert.match(quiet.printed, /no unacknowledged warning or critical alerts — 4 info/);
  assert.equal(alertRun(t, [], true).code, 0);

  // even full rows (a private query's) print no message, ref, time, wallet or contact, and odd kinds print as "other"
  const WALLET = ATTACKER;
  const full = [
    { severity: 'warn', kind: 'sanctioned_wallet', message: `Refused a launch naming ${WALLET} (on the OFAC sanctions list)`, ref: WALLET, created_at: 1_761_000_000_000 },
    { severity: 'info', kind: 'report', message: 'report from reporter@example.com about ChIJabc', ref: 'ChIJabc', created_at: 1_761_000_000_000 },
    { severity: 'critical', kind: `rpc key ${WALLET}`, message: 'x', ref: null, created_at: 1_761_000_000_000 },
  ];
  const pub = alertRun(t, full, true);
  assert.equal(pub.code, 2);
  for (const secret of [WALLET, 'reporter@example.com', 'ChIJabc', 'OFAC', 'Refused', '2025-']) assert.ok(!pub.printed.includes(secret), `public log printed ${secret}`);
  assert.match(pub.printed, /CRITICAL alerts: 1 — other ×1/);
  assert.match(pub.printed, /warn alerts: 1 — sanctioned_wallet ×1/);
  assert.match(pub.printed, /info alerts: 1 — report ×1/);
  assert.ok(!JSON.stringify(pub.checks.items).includes(WALLET), 'nor do the items (webhook text, --json report)');

  // a private run (no flag, e.g. on the operator's machine) still lists each alert in full
  const priv = alertRun(t, full, false);
  assert.equal(priv.code, 2);
  assert.ok(priv.printed.includes(WALLET));
  assert.match(priv.printed, /info alert — .* report: report from reporter@example\.com/);
});

/** The watchdog's alerts queries over fabricated rows: node:sqlite (D1 is SQLite) with every migration applied. */
function alertsDb(rows) {
  const db = new DatabaseSync(':memory:');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  const insert = db.prepare('INSERT INTO alerts (severity, kind, message, ref, created_at, acked_at) VALUES (?, ?, ?, ?, ?, ?)');
  rows.forEach((r, i) => insert.run(r.severity, r.kind ?? 'k', `alert ${i}`, null, 1_761_000_000_000 + i, r.acked ? 1 : null));
  return db;
}

test('watchdog --public-log: counts the same latest 30 alerts as a private run, so both exit alike', (t) => {
  const info = (n, acked = false) => Array.from({ length: n }, () => ({ severity: 'info', kind: 'claim_website_verified', acked }));
  const cases = [
    // [name, rows oldest first, expected exit code of both runs]
    ['an old critical, then 30 newer info: aged out', [{ severity: 'critical', kind: 'admin_changed' }, ...info(30)], 0],
    ['an old critical, then 29 newer info: still in the window', [{ severity: 'critical', kind: 'admin_changed' }, ...info(29)], 2],
    ['an old warn, then 30 newer info: aged out', [{ severity: 'warn', kind: 'price_spread' }, ...info(30)], 0],
    ['an old warn, then 29 newer info', [{ severity: 'warn', kind: 'price_spread' }, ...info(29)], 1],
    ['acked alerts do not fill the window', [{ severity: 'critical', kind: 'admin_changed' }, ...info(10, true), ...info(29)], 2],
    ['a year of price_spread warnings behind a quiet month', [...Array.from({ length: 24 * 365 }, () => ({ severity: 'warn', kind: 'price_spread' })), ...info(30)], 0],
    ['mixed, fewer than 30', [{ severity: 'warn', kind: 'price_spread' }, { severity: 'critical', kind: 'creator_changed' }, ...info(3)], 2],
    ['none', [], 0],
  ];
  for (const [name, rows, expected] of cases) {
    const db = alertsDb(rows);
    const privRows = db.prepare(alertsQuery(false)).all();
    const pubRows = db.prepare(alertsQuery(true)).all();
    assert.ok(privRows.length <= ALERTS_WINDOW, name);
    assert.equal(pubRows.reduce((s, r) => s + r.n, 0), privRows.length, `${name}: the public counts cover the private rows`);
    const priv = alertRun(t, privRows, false);
    const pub = alertRun(t, pubRows, true);
    assert.equal(priv.code, expected, `${name}: private exit`);
    assert.equal(pub.code, priv.code, `${name}: public exit = private exit`);
    db.close();
  }

  // both walk the primary key newest first and stop at the LIMIT (no sort of the whole table): ~30 D1 row reads a run
  const db = alertsDb([]);
  for (const q of [alertsQuery(false), alertsQuery(true)]) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${q}`).all().map((r) => r.detail).join('; ');
    assert.ok(!/FOR ORDER BY/.test(plan), plan);
  }
  db.close();
});

test('watchdog workflow: the public GitHub log runs --public-log', () => {
  const yml = readFileSync(join(ROOT, '.github', 'workflows', 'watchdog.yml'), 'utf8');
  assert.match(yml, /node scripts\/watchdog\.mjs --cluster mainnet --alert --public-log \$d1/);
  assert.match(readFileSync(join(ROOT, 'scripts', 'watchdog.mjs'), 'utf8'), /parseArgs\(process\.argv\.slice\(2\), \[[^\]]*'public-log'[^\]]*\]\)/, '--public-log is an on/off flag');
});

/** The `run: |` script of the workflow step named `name` (dedented), for running it under bash as Actions would. */
function stepScript(yml, name) {
  const lines = yml.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `no step "${name}"`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
  const indent = lines[runAt].search(/\S/);
  const body = [];
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() && l.search(/\S/) <= indent) break;
    body.push(l);
  }
  const pad = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(pad)).join('\n');
}

/** Runs a step script in `cwd` with GitHub's shell flags; returns the exit code, output and the $GITHUB_OUTPUT file. */
function runStep(script, cwd, env) {
  const out = join(cwd, 'github-output');
  writeFileSync(out, '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd, env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env }, encoding: 'utf8' });
  return { code: r.status, text: r.stdout + r.stderr, output: readFileSync(out, 'utf8') };
}

const hasTool = (cmd) => spawnSync('bash', ['-c', `command -v ${cmd}`]).status === 0;
const BACKUP_YML = () => readFileSync(join(ROOT, '.github', 'workflows', 'd1-backup.yml'), 'utf8');

test('d1-backup: runs only with mainnet live, the Cloudflare secrets, vars.D1_BACKUP_ENABLED=true AND the passphrase', (t) => {
  if (!hasTool('jq')) return t.skip('jq is not installed');
  const yml = BACKUP_YML();
  assert.match(yml, /ENABLED: \$\{\{ vars\.D1_BACKUP_ENABLED == 'true' \}\}/);
  assert.match(yml, /HAS_PASS: \$\{\{ secrets\.D1_BACKUP_PASSPHRASE != '' \}\}/);
  const gate = stepScript(yml, 'Mainnet live and backup configured?');
  const dir = mkdtempSync(join(tmpdir(), 'cs-backup-'));
  mkdirSync(join(dir, 'deploy'));
  const all = { HAS_TOKEN: 'true', ENABLED: 'true', HAS_PASS: 'true' };
  const live = (env) => runStep(gate, dir, env);

  // not live yet (no record, or a dry run's record without the ALT): nothing to back up, whatever is configured
  assert.match(live(all).output, /^live=false$/m);
  writeFileSync(join(dir, 'deploy', 'mainnet.json'), JSON.stringify({ programId: PROGRAM }));
  assert.match(live(all).output, /^live=false$/m);
  writeFileSync(join(dir, 'deploy', 'mainnet.json'), JSON.stringify({ programId: PROGRAM, alt: ALT }));

  assert.match(live(all).output, /^live=true$/m);
  const noToken = live({ ...all, HAS_TOKEN: 'false' });
  assert.match(noToken.output, /^live=false$/m);
  assert.match(noToken.text, /::notice::No CLOUDFLARE_API_TOKEN/);
  // the Cloudflare secrets alone (added for the watchdog's D1 reads) never start a backup
  for (const env of [{ ...all, ENABLED: 'false' }, { ...all, HAS_PASS: 'false' }, { HAS_TOKEN: 'true', ENABLED: 'false', HAS_PASS: 'false' }]) {
    const r = live(env);
    assert.equal(r.code, 0, 'skipping is green');
    assert.match(r.output, /^live=false$/m);
    assert.match(r.text, /::notice::Backup off: it needs vars\.D1_BACKUP_ENABLED=true and the D1_BACKUP_PASSPHRASE secret/);
  }
});

test('d1-backup: never uploads plaintext; the encrypted dump decrypts with the documented openssl parameters', (t) => {
  if (!hasTool('openssl')) return t.skip('openssl is not installed');
  const yml = BACKUP_YML();
  const encrypt = stepScript(yml, 'Encrypt (required)');
  const STAMP = '20261029T031700Z';
  const dump = Buffer.from('INSERT INTO reports VALUES (1, "reporter@example.com");\n');
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-backup-'));
    mkdirSync(join(dir, 'backup'));
    writeFileSync(join(dir, 'backup', `cornershop-mainnet-${STAMP}.sql.gz`), dump);
    return dir;
  };

  // no passphrase: the job fails and the plain dump is deleted before the upload step could see it
  const bare = setup();
  const refused = runStep(encrypt, bare, { STAMP, PASSPHRASE: '' });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /::error::D1_BACKUP_PASSPHRASE is required/);
  assert.deepEqual(readdirSync(join(bare, 'backup')), []);

  const dir = setup();
  const PASSPHRASE = 'correct horse battery staple';
  const r = runStep(encrypt, dir, { STAMP, PASSPHRASE });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(readdirSync(join(dir, 'backup')), [`cornershop-mainnet-${STAMP}.sql.gz.enc`]);
  const docs = readFileSync(join(ROOT, 'docs', 'OPS-AUTOMATION.md'), 'utf8');
  assert.match(docs, /openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in cornershop-mainnet-<stamp>\.sql\.gz\.enc -out backup\.sql\.gz/);
  const plain = join(dir, 'plain');
  const dec = spawnSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-in', join(dir, 'backup', `cornershop-mainnet-${STAMP}.sql.gz.enc`), '-out', plain, '-pass', 'env:PASSPHRASE'], { env: { PATH: process.env.PATH, PASSPHRASE } });
  assert.equal(dec.status, 0, String(dec.stderr));
  assert.ok(existsSync(plain) && readFileSync(plain).equals(dump));

  // only *.enc is uploaded; wrangler comes from package-lock.json, not a fresh `npx --yes` tree
  assert.match(yml, /^\s+path: backup\/\*\.enc$/m);
  assert.ok(!/^\s+path: backup\/?$/m.test(yml));
  assert.ok(!/npx --yes/.test(yml));
  assert.match(yml, /run: npm ci --ignore-scripts/);
  assert.match(yml, /"\$GITHUB_WORKSPACE\/node_modules\/\.bin\/wrangler" d1 export cornershop-mainnet --remote/);
  assert.match(yml, /downloaded by ANY signed-in GitHub user/);
  assert.ok(!/private repo/i.test(yml));
});

test('workflows: every action is pinned to a full commit SHA with its version comment; CI has a read-only token', () => {
  const dir = join(ROOT, '.github', 'workflows');
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length >= 4, files.join(', '));
  let pins = 0;
  for (const f of files) {
    const yml = readFileSync(join(dir, f), 'utf8');
    for (const [line] of yml.matchAll(/^\s*(?:-\s+)?uses:.*$/gm)) {
      // a tag or branch can be moved under us; a commit cannot (dependabot.yml keeps the pins current)
      assert.match(line, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # \S/, `${f}: ${line.trim()}`);
      pins++;
    }
    assert.match(yml, /^permissions:\n {2}contents: read$/m, `${f}: top-level read-only permissions`);
  }
  assert.ok(pins >= 10, `${pins} pinned actions`);
  // dtolnay/rust-toolchain's ref used to be the toolchain name: state it now the ref is a commit
  const rust = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n').match(/uses: dtolnay\/rust-toolchain@.*\n(?:\s+if: .*\n)?\s+with:\n\s+toolchain: stable\n/g);
  assert.equal(rust?.length, 2, 'ci.yml and verifiable-build.yml');
});

test('dependabot covers both npm trees, the program crate and the action pins; issues route security reports privately', () => {
  const dep = readFileSync(join(ROOT, '.github', 'dependabot.yml'), 'utf8');
  const entries = [...dep.matchAll(/- package-ecosystem: (\S+)\n\s+directory: (\S+)\n\s+schedule:\n\s+interval: (\S+)/g)].map((m) => m.slice(1).join(' '));
  assert.deepEqual(entries, ['npm / weekly', 'npm /programs/shop-vault/client weekly', 'cargo /programs/shop-vault weekly', 'github-actions / weekly']);
  for (const dir of ['programs/shop-vault/client/package-lock.json', 'programs/shop-vault/Cargo.lock', 'package-lock.json']) assert.ok(existsSync(join(ROOT, dir)), dir);
  const issues = readFileSync(join(ROOT, '.github', 'ISSUE_TEMPLATE', 'config.yml'), 'utf8');
  assert.match(issues, /^blank_issues_enabled: false$/m);
  assert.match(issues, /url: https:\/\/github\.com\/AtlasPadHQ\/atlaspad\/security\/advisories\/new$/m);
  assert.match(readFileSync(join(ROOT, '.github', 'ISSUE_TEMPLATE', 'bug_report.yml'), 'utf8'), /Report a vulnerability/);
});
