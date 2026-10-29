#!/usr/bin/env node
/**
 * Read-only governance watchdog (SPEC §8.6, T10-T12; RUNBOOK "Alerts"). Complements the Worker's per-minute program
 * monitor: run it from a machine that is NOT the request-path Worker (launchd/cron every 15 min, by hand, or the free
 * GitHub Actions schedule in .github/workflows/watchdog.yml, docs/OPS-AUTOMATION.md). It never holds a key: it tells
 * a human what to sign and by when.
 *
 *   node scripts/watchdog.mjs --cluster mainnet [--origin https://atlaspad.online | none] [--no-d1] [--public-log]
 *                             [--json] [--alert]
 *   node scripts/watchdog.mjs --cluster devnet --loop 300
 *
 * Checks: Config keys and the upgrade authority vs the EXPECTED state from deploy/<cluster>.json (lib/expected.mjs:
 * the planned handover of governance to Squads vault A and of the upgrade authority to Squads vault B is expected;
 * any other change is CRITICAL) · paused · probation · every pending attestor / guardian / governance proposal
 * against D1 admin_expectations (the planned Squads A handover proposal passes without D1; anything else unregistered
 * → CRITICAL with the veto deadline) · the crank's SOL balance (warn below 0.02, CRITICAL below 0.005: top it up from any
 * wallet) · unacknowledged alerts in D1 · /api/health (indexer lag, attestor match;
 * unreachable on mainnet after one retry = CRITICAL, e.g. a broken deploy or the Workers Free daily limit).
 * RPC: RPC_URL when set (only its origin is printed), else the public endpoint.
 *
 * Alerts: with --loop, every CRITICAL result is POSTed to ALERT_WEBHOOK_URL (env or .env.server; a Discord webhook,
 * optional) and the loop keeps running (the same findings are re-posted at most hourly, a RESOLVED message follows when
 * they clear, and 3 failed runs in a row post too). A single run posts only with --alert. It runs off the Worker, so it
 * cannot use the Worker's alert email: the free email path is exit code 2 failing the GitHub Actions run, which GitHub
 * emails to you (.github/workflows/watchdog.yml).
 * --public-log (the GitHub Actions run, whose log is public on a public repo): D1 alerts as counts per severity and kind
 * only, never their messages or refs (reportAlerts), over the same latest 30 (alertsQuery). Exit codes are the same.
 * Exit codes (single run): 0 ok · 1 warnings · 2 critical (wire it to a notification) · 3 the run itself failed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { alertDecision, alertText, findingsDigest, postAlert, webhookUrl } from './lib/alert.mjs';
import { readDeploy } from './lib/deployJson.mjs';
import { assessAuthorities, assessProposal, criticalFindings, exitCodeOf, expectedState } from './lib/expected.mjs';
import { Checks, fatal, head, info, parseArgs, sleep, warn } from './lib/log.mjs';
import { publicOrigin } from './lib/origin.mjs';
import { CONFIG_PDA, OUT_DIR } from './lib/paths.mjs';
import { deployedProgram } from './lib/program.mjs';
import { assertGenesis, chainTime, getAccount, getBalance, label, rpcUrl } from './lib/rpc.mjs';
import { d1Execute } from './lib/wrangler.mjs';

const iso = (s) => new Date(Number(s) * 1000).toISOString();
const hoursLeft = (eta, now) => ((Number(eta) - Number(now)) / 3600).toFixed(1);

/** Pending proposals of a decoded Config → [{ kind, key, eta, escalated, label, byGuardian? }] (kinds as SPEC §7). */
export function pendingProposals(cfg) {
  const out = [];
  if (cfg.pendingAttestor) out.push({ kind: 1, key: cfg.pendingAttestor.toBase58(), eta: cfg.pendingAttestorEta, escalated: cfg.attestorProposalEscalated, label: 'attestor rotation' });
  if (cfg.pendingGuardian) out.push({ kind: 6, key: cfg.pendingGuardian.toBase58(), eta: cfg.pendingGuardianEta, escalated: cfg.guardianProposalEscalated, label: 'guardian rotation' });
  if (cfg.pendingGovernance) out.push({ kind: 4, key: cfg.pendingGovernance.toBase58(), eta: cfg.pendingGovernanceEta, escalated: false, byGuardian: cfg.pendingGovernanceByGuardian, label: cfg.pendingGovernanceByGuardian ? 'governance RECOVERY (proposed by the guardian)' : 'governance handover' });
  return out;
}

/** What a human must do about an unregistered proposal. */
export function responseFor(p) {
  if (p.kind === 1 || p.kind === 6) {
    return p.escalated
      ? `escalated proposal: the guardian can no longer veto it; governance must replace/withdraw it, warn owners to withdraw (SPEC T11)`
      : `guardian must veto: cancel_${p.kind === 1 ? 'attestor' : 'guardian'}_proposal before ${iso(p.eta)}`;
  }
  if (p.byGuardian) return `governance must withdraw it (propose_governance(zero key) from Squads vault A) before ${iso(p.eta)}`;
  return 'governance handover not registered: verify with every Squads member; withdraw with propose_governance(zero key) if unknown';
}

/** Crank balance floors: below CRANK_WARN the owner tops it up; below CRANK_CRITICAL finalize / fee-collect stall soon. */
export const CRANK_WARN = 20_000_000n;
export const CRANK_CRITICAL = 5_000_000n;

/**
 * The crank (deploy/<cluster>.json `crank`) pays every finalize_claim and fee-collect fee and pump's creator-vault rent
 * per coin; nothing else watches its balance. Returns { status, what, detail } (a CRITICAL fail exits 2).
 */
export function crankFinding(crank, lamports) {
  if (!crank) return { status: 'warn', what: 'crank balance', detail: 'deploy json has no crank address: balance not checked' };
  const sol = (l) => `${(Number(l) / 1e9).toFixed(4)} SOL`;
  const topUp = `send ≈0.1 SOL to ${crank} from any wallet`;
  if (lamports < CRANK_CRITICAL) return { status: 'fail', what: 'CRITICAL crank nearly empty', detail: `${sol(lamports)} < ${sol(CRANK_CRITICAL)}: claims stop finalizing and fees stop being collected; ${topUp}` };
  if (lamports < CRANK_WARN) return { status: 'warn', what: 'crank low', detail: `${sol(lamports)} < ${sol(CRANK_WARN)}: ${topUp}` };
  return { status: 'ok', what: 'crank balance', detail: `${sol(lamports)} (${crank})` };
}

/**
 * The guardian pays the fee of every guardian action (scripts/guardian.mjs: cancel a wrong claim, pause): with no SOL
 * those fail exactly when they are needed, so a near-empty guardian is a warning.
 */
export const GUARDIAN_WARN = 1_000_000n; // 0.001 SOL
export function guardianFinding(guardian, lamports) {
  const sol = (l) => `${(Number(l) / 1e9).toFixed(4)} SOL`;
  if (lamports < GUARDIAN_WARN) return { status: 'warn', what: 'guardian cannot pay fees', detail: `${sol(lamports)} < ${sol(GUARDIAN_WARN)}: send it ≈0.01 SOL (${guardian})` };
  return { status: 'ok', what: 'guardian balance', detail: `${sol(lamports)} (${guardian})` };
}

/** The site whose /api/health is checked: --origin <url>, --origin none (skip), else the cluster's PUBLIC_ORIGIN. */
export function watchdogOrigin(args, cluster, cfg) {
  if (args.origin === undefined) return publicOrigin(cluster, cfg);
  return args.origin === 'none' ? null : String(args.origin);
}

/**
 * A run reads the latest ALERTS_WINDOW unacknowledged alerts, newest first. Nothing acks or prunes the alerts table, so
 * this window is what ages an old alert out, and it keeps a run at about that many D1 row reads (Workers Free).
 */
export const ALERTS_WINDOW = 30;

/**
 * The D1 alerts query. With --public-log only counts leave D1 (no message, ref or time can reach the log), counted over
 * the same window as a private run, so both exit with the same code on the same database.
 */
export function alertsQuery(publicLog = false) {
  const latest = `FROM alerts WHERE acked_at IS NULL ORDER BY id DESC LIMIT ${ALERTS_WINDOW}`;
  return publicLog
    ? `SELECT severity, kind, COUNT(*) AS n FROM (SELECT severity, kind ${latest}) GROUP BY severity, kind`
    : `SELECT severity, kind, message, ref, created_at ${latest}`;
}

/** Alert kinds and severities are code constants in the Worker; a public log prints any other kind as "other". */
const PUBLIC_KIND = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * Unacknowledged D1 alerts → check items. A private run lists each alert in full. --public-log (the GitHub Actions log,
 * readable by anyone once the repo is public) prints counts per severity and kind only: messages and refs name
 * wallets, places, websites and report contacts, and the full text already reaches the operator by the Worker's alert
 * email / webhook or a local run. Either way a critical alert is a CRITICAL failure (exit 2), any other non-info alert a
 * warning (exit 1), and info alerts (claims, reports, opt-outs: emailed, routine) are listed, not counted as warnings.
 */
export function reportAlerts(checks, rows, { publicLog = false } = {}) {
  const count = (r) => Number(r.n ?? 1) || 0;
  if (!rows.some((r) => r.severity !== 'info')) {
    const infos = rows.reduce((s, r) => s + count(r), 0);
    checks.pass('no unacknowledged warning or critical alerts', infos ? `${infos} info` : undefined);
  }
  if (!publicLog) {
    for (const r of rows) {
      const line = `${new Date(r.created_at).toISOString()} ${r.kind}: ${r.message}${r.ref ? ` (${r.ref})` : ''}`;
      if (r.severity === 'critical') checks.fail('CRITICAL alert', line);
      else if (r.severity === 'info') info(`info alert — ${line}`);
      else checks.warn(`${r.severity} alert`, line);
    }
    return;
  }
  const bySeverity = new Map();
  for (const r of rows) {
    const sev = PUBLIC_KIND.test(String(r.severity)) ? r.severity : 'warn'; // unknown: a warning, as in a private run
    const kind = PUBLIC_KIND.test(String(r.kind)) ? r.kind : 'other';
    const kinds = bySeverity.get(sev) ?? new Map();
    kinds.set(kind, (kinds.get(kind) ?? 0) + count(r));
    bySeverity.set(sev, kinds);
  }
  const rank = (s) => (s === 'critical' ? 0 : s === 'info' ? 2 : 1);
  for (const [sev, kinds] of [...bySeverity].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))) {
    const total = [...kinds.values()].reduce((s, n) => s + n, 0);
    const detail = [...kinds].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ×${n}`).join(', ');
    if (sev === 'critical') checks.fail(`CRITICAL alerts: ${total}`, `${detail} (full text: the Worker's alert email or webhook, or run the watchdog locally)`);
    else if (sev === 'info') info(`info alerts: ${total} — ${detail}`);
    else checks.warn(`${sev} alerts: ${total}`, detail);
  }
}

export async function watch({ cluster, origin, useD1 = true, publicLog = false }) {
  const checks = new Checks();
  const url = rpcUrl(cluster);
  await assertGenesis(url, cluster);
  const { sv } = await import('./lib/web3.mjs');
  const dep = readDeploy(cluster) ?? {};
  const expected = expectedState(dep);
  const now = await chainTime(url);
  const report = { cluster, rpc: label(url), at: new Date().toISOString(), chainTime: Number(now) };
  const apply = (f) => (f.status === 'ok' ? checks.pass(f.what, f.detail) : f.status === 'warn' ? checks.warn(f.what, f.detail) : checks.fail(f.what, f.detail));

  head('Config');
  const acc = await getAccount(url, CONFIG_PDA);
  if (!acc) {
    checks.fail('Config', 'not initialised on this cluster');
    return { checks, report };
  }
  const cfg = sv.decodeConfig(acc.data);
  report.config = { attestor: cfg.attestor.toBase58(), guardian: cfg.guardian.toBase58(), governance: cfg.governance.toBase58(), paused: cfg.paused, probationUntil: Number(cfg.probationUntil), claimWindowSecs: Number(cfg.claimWindowSecs) };
  checks.check(cfg.flavor === cluster, 'Config flavor', cfg.flavor);
  const config = { attestor: cfg.attestor.toBase58(), guardian: cfg.guardian.toBase58(), governance: cfg.governance.toBase58() };
  const prog = await deployedProgram(url);
  const authorities = assessAuthorities({ cluster, config, program: prog, expected });
  for (const f of authorities.filter((x) => x.role === 'attestor' || x.role === 'guardian')) apply(f);
  if (cfg.paused) checks.warn('launches paused', 'Config.paused = 1 (trading, claims and withdrawals still work)');
  else checks.pass('launches not paused');
  if (cfg.probationUntil > now) checks.warn('probation active', `until ${iso(cfg.probationUntil)}: new claims unlock at probation end + window; the banner must show (SPEC §8.6)`);

  head('pending proposals');
  const pending = pendingProposals(cfg);
  if (!pending.length) checks.pass('no pending attestor/guardian/governance proposal');
  let expectations = null;
  if (pending.length && useD1) {
    try {
      expectations = await d1Execute(cluster, 'SELECT kind, key FROM admin_expectations');
    } catch (e) {
      checks.warn('admin_expectations', `D1 not readable (${e.message.slice(0, 120)}); treating every proposal as unregistered`);
    }
  }
  for (const p of pending) {
    const registered = (expectations ?? []).some((e) => Number(e.kind) === p.kind && e.key === p.key);
    const detail = `${p.key} · eta ${iso(p.eta)} (${hoursLeft(p.eta, now)} h)${p.escalated ? ' · ESCALATED' : ''}`;
    const a = assessProposal(p, { expected, registered });
    if (a.planned) checks.warn(`${p.label} (${registered ? 'registered' : `planned: Squads vault A in deploy/${cluster}.json`})`, detail);
    else checks.fail(`CRITICAL unregistered ${p.label}`, `${detail} → ${responseFor(p)}`);
  }

  head(`governance and upgrade authority (expected state: deploy/${cluster}.json)`);
  for (const f of authorities.filter((x) => x.role === 'governance' || x.role === 'upgradeAuthority')) apply(f);

  head(`crank (fee payer, deploy/${cluster}.json)`);
  const crankLamports = dep.crank ? await getBalance(url, dep.crank) : 0n;
  report.crankLamports = dep.crank ? Number(crankLamports) : null;
  apply(crankFinding(dep.crank, crankLamports));
  apply(guardianFinding(config.guardian, await getBalance(url, config.guardian)));

  if (useD1) {
    head(`unacknowledged alerts (D1${publicLog ? ', counts only: --public-log' : ''})`);
    try {
      const rows = await d1Execute(cluster, alertsQuery(publicLog));
      report.alerts = rows;
      reportAlerts(checks, rows, { publicLog });
    } catch (e) {
      checks.warn('alerts', `D1 not readable (${e.message.slice(0, 120)})`);
    }
  }

  if (origin) {
    head('/api/health');
    const getHealth = () => fetch(new URL('/api/health', origin), { signal: AbortSignal.timeout(15_000) }).then((r) => r.json());
    try {
      const h = await getHealth().catch(async () => (await sleep(5_000), getHealth())); // one retry: a network blip is not an outage
      report.health = h;
      checks.check(h.ok === true, 'health ok', `indexer lag ${h.indexerLagSec ?? '—'} s · attestor ${h.checks?.attestor}`);
      if (h.checks?.attestor && h.checks.attestor !== 'ok') checks.fail('CRITICAL Worker attestor ≠ Config.attestor', h.checks.attestor);
    } catch (e) {
      // Mainnet: the site's API is down (Worker error, 1027 daily limit, bad deploy): the owner must know now.
      checks.fail(cluster === 'mainnet' ? 'CRITICAL /api/health unreachable' : 'health', `${origin}: ${e.message}`);
    }
  }
  report.checks = checks.toJSON();
  return { checks, report };
}

/**
 * The alert decision of one --loop iteration. `result` is `{ items }` (a finished run's check items) or `{ error }`
 * (the run threw). A failed run alerts only after `errorRuns` failures in a row (one flaky RPC call is not an
 * incident). Returns the post to make (or null) and the next state `{ last, errors }`.
 */
export function loopAlert(state, result, now, { repeatMs = 3_600_000, errorRuns = 3 } = {}) {
  const errors = result.error ? state.errors + 1 : 0;
  if (result.error && errors < errorRuns) return { post: null, state: { ...state, errors } };
  const findings = result.error
    ? [{ key: 'watchdog-error', what: `CRITICAL watchdog cannot run (${errorRuns}+ runs in a row failed)`, detail: String(result.error).slice(0, 300) }]
    : criticalFindings(result.items);
  const digest = findingsDigest(findings);
  const decision = alertDecision(state.last, digest, now, repeatMs);
  if (!decision) return { post: null, state: { ...state, errors } };
  return { post: { kind: decision, findings }, state: { last: { digest: decision === 'critical' ? digest : null, at: now }, errors } };
}

/**
 * The loop state after a post attempt: a delivered post becomes `last`; an undelivered one (webhook down, 4xx, not
 * set) keeps the previous `last`, so the next run tries again instead of staying silent for an hour.
 */
export function afterSend(prev, step, sent) {
  return sent ? step.state : { ...step.state, last: prev.last };
}

async function send(cluster, post) {
  const r = await postAlert(alertText({ cluster, findings: post.findings, resolved: post.kind === 'resolved' }));
  if (r.sent) info(`alert posted to ALERT_WEBHOOK_URL (${post.kind}, ${post.findings.length} finding(s))`);
  else warn(`alert NOT posted: ${r.reason}`);
  return r;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['json', 'no-d1', 'alert', 'public-log']);
  const cluster = args.cluster ?? 'devnet';
  if (!['devnet', 'mainnet'].includes(cluster)) fatal('--cluster devnet|mainnet', 64);
  const origin = watchdogOrigin(args, cluster);
  const loop = Number(args.loop ?? 0);
  if (!Number.isFinite(loop) || loop < 0 || (loop > 0 && loop < 30)) fatal('--loop <seconds, at least 30>', 64);
  if ((loop || args.alert) && !webhookUrl()) {
    if (loop) warn('ALERT_WEBHOOK_URL is not set (env or .env.server): critical results are only printed');
    else info('ALERT_WEBHOOK_URL is not set: nothing is posted; a critical result exits 2 (on GitHub Actions that fails the run, and GitHub emails you)');
  }
  let state = { last: null, errors: 0 };
  for (;;) {
    head(`watchdog · ${cluster} · ${new Date().toISOString()}`);
    let result;
    try {
      const { checks, report } = await watch({ cluster, origin, useD1: !args['no-d1'], publicLog: !!args['public-log'] });
      checks.summary('watchdog');
      result = { items: checks.items, report };
    } catch (e) {
      if (!loop) fatal(`watchdog run failed: ${e.message}`, 3);
      warn(`watchdog run failed: ${e.message}`);
      result = { error: e.message };
    }
    const code = result.items ? exitCodeOf(result.items) : 3;
    let posted = null;
    if (loop) {
      const step = loopAlert(state, result, Date.now());
      if (step.post) posted = await send(cluster, step.post);
      state = step.post ? afterSend(state, step, posted.sent) : step.state;
    } else if (args.alert && code === 2) {
      posted = await send(cluster, { kind: 'critical', findings: criticalFindings(result.items) });
    }
    if (args.json && result.report) {
      mkdirSync(OUT_DIR, { recursive: true });
      const alert = posted ? { sent: posted.sent, status: posted.status ?? null } : null;
      writeFileSync(join(OUT_DIR, `watchdog-${cluster}.json`), JSON.stringify({ ...result.report, exitCode: code, alert }, null, 2));
    }
    if (!loop) process.exit(code);
    info(`next run in ${loop} s`);
    await sleep(loop * 1000);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fatal(e.message, 3));
}
