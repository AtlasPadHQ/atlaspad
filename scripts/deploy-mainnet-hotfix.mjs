#!/usr/bin/env node
/**
 * Safe post-launch FIX DEPLOY of the mainnet Worker `cornershop` (docs/OPS-AUTOMATION.md "Hotfix"). DRY RUN by default.
 * Only the Worker code and its static assets change: never the program, Config, the ALT, keys or secrets.
 *
 *   node scripts/deploy-mainnet-hotfix.mjs              # dry run: preflight, build:mainnet, check-bundle, the vars plan
 *   node scripts/deploy-mainnet-hotfix.mjs --execute    # + typed confirmation, wrangler deploy --env mainnet, smoke
 *   options: --migrate (apply pending D1 migrations before the deploy; otherwise pending migrations refuse) ·
 *            --skip-build (dry run only) · --allow-dirty (deploy uncommitted changes) · --yes (no prompt; still needs
 *            --execute) · --origin <url> (smoke target; default ORIGINS.mainnet, the public site)
 *
 * Why not a plain `wrangler deploy --env mainnet`: wrangler.jsonc keeps ALT_ADDRESS empty (go-mainnet passes it with
 * --var), and wrangler deletes every var that is not in the config or on the command line. This script passes ALL of
 * them: ALT_ADDRESS and PROGRAM_ID from deploy/mainnet.json, env.mainnet.vars from wrangler.jsonc, any var that is
 * only on the live Worker (kept, with a warning), and a new BUILD_ID. It refuses when a value would silently change
 * (live ALT_ADDRESS ≠ deploy/mainnet.json, or a live value would be blanked by an empty wrangler.jsonc value), and with
 * --execute when the live version, its vars or the D1 migration status cannot be read (unknownLiveState).
 *
 * Steps: preflight (wrangler login, deploy/mainnet.json, env.mainnet shape, D1 id, required secret NAMES on the
 * Worker, pending migrations, git state, the live version = rollback target and its vars) → build:mainnet →
 * check-bundle dist-mainnet --cluster mainnet --build-worker → [migrations] → deploy → smoke (6 tries, 10 s apart) →
 * scripts/out/hotfix-mainnet-<ts>.json. Rollback: `npx wrangler rollback <previous version id> --env mainnet`
 * (printed before the deploy). Names only: no secret value is read here.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { isAddress } from './lib/b58.mjs';
import { readDeploy } from './lib/deployJson.mjs';
import { Checks, head, info, ok, parseArgs, sleep, warn } from './lib/log.mjs';
import { D1_PLACEHOLDERS, ORIGINS, OUT_DIR, ROOT, WORKER_NAMES } from './lib/paths.mjs';
import { run } from './lib/proc.mjs';
import { configuredD1Id, d1MigrateRemote, deploymentsList, envConfig, envProblems, expectedAccountId, pendingMigrations, readWranglerConfig, secretNames, whoamiMatches, wrangler, WRANGLER_LOGIN_FIX } from './lib/wrangler.mjs';

/** deploy/mainnet.json field → Worker var. These values exist only in deploy/mainnet.json (and on the live Worker). */
export const DEPLOY_JSON_VARS = { alt: 'ALT_ADDRESS', programId: 'PROGRAM_ID' };
const MANAGED = new Set([...Object.values(DEPLOY_JSON_VARS), 'BUILD_ID']);

/** The version currently serving traffic: newest deployment (by created_on), its version with the largest share. */
export function currentVersionId(deployments) {
  const list = Array.isArray(deployments) ? deployments : deployments?.deployments;
  if (!Array.isArray(list) || !list.length) return null;
  const latest = [...list].sort((a, b) => String(a.created_on ?? '').localeCompare(String(b.created_on ?? ''))).pop();
  const versions = [...(latest?.versions ?? [])].sort((a, b) => (b.percentage ?? 0) - (a.percentage ?? 0));
  return versions[0]?.version_id ?? null;
}

/**
 * Plain vars of a `wrangler versions view <id> --json` result → { name: value }. JSON vars are returned in `json`
 * (they cannot be passed with --var). Secrets and other bindings are ignored (names only, never values).
 */
export function liveVarsOf(version) {
  const vars = {};
  const json = [];
  for (const b of version?.resources?.bindings ?? []) {
    if (b?.type === 'plain_text' && typeof b.name === 'string') vars[b.name] = String(b.text ?? '');
    else if (b?.type === 'json' && typeof b.name === 'string') json.push(b.name);
  }
  return { vars, json };
}

/**
 * The vars of the hotfix deploy. `liveVars` is null when the live Worker could not be read.
 * @param {{ configVars: Record<string, unknown>, deploy: Record<string, unknown>|null, liveVars: Record<string,string>|null,
 *   liveJsonVars?: string[], buildId: string }} o
 * @returns {{ vars: Record<string,string>, finalVars: Record<string,string>, kept: string[],
 *   changes: { name: string, from: string|undefined, to: string|undefined }[], problems: string[] }}
 *   `vars` = what to pass with --var; `finalVars` = everything the Worker will have.
 */
export function planVars({ configVars = {}, deploy, liveVars, liveJsonVars = [], buildId }) {
  const problems = [];
  const vars = {};
  const config = Object.fromEntries(Object.entries(configVars).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  for (const [field, name] of Object.entries(DEPLOY_JSON_VARS)) {
    const value = deploy?.[field];
    if (typeof value !== 'string' || !isAddress(value)) {
      problems.push(`deploy/mainnet.json has no valid ${field} (the Worker's ${name})`);
      continue;
    }
    if (config[name] && config[name] !== value) problems.push(`wrangler.jsonc env.mainnet.vars.${name} is ${config[name]} but deploy/mainnet.json ${field} is ${value}`);
    if (liveVars?.[name] && liveVars[name] !== value) problems.push(`the live Worker's ${name} is ${liveVars[name]} but deploy/mainnet.json ${field} is ${value}: find out why before deploying`);
    vars[name] = value;
  }
  if (!/^[\w.:-]{1,64}$/.test(String(buildId ?? ''))) problems.push('BUILD_ID is not a short id');
  vars.BUILD_ID = String(buildId);
  const kept = [];
  for (const [name, value] of Object.entries(liveVars ?? {})) {
    if (MANAGED.has(name)) continue;
    if (!(name in config)) {
      vars[name] = value;
      kept.push(name);
    } else if (config[name] === '' && value !== '') {
      problems.push(`wrangler.jsonc env.mainnet.vars.${name} is empty but the live Worker has a value: put that value in wrangler.jsonc first (a deploy would blank it)`);
    }
  }
  for (const name of liveJsonVars) if (!(name in config)) problems.push(`the live Worker has a JSON var ${name} that is not in wrangler.jsonc: add it there (--var cannot keep JSON vars)`);
  for (const [name, value] of Object.entries(vars)) if (/[\r\n]/.test(value)) problems.push(`var ${name} contains a newline`);
  const finalVars = { ...config, ...vars };
  const changes = [];
  if (liveVars) {
    for (const name of new Set([...Object.keys(liveVars), ...Object.keys(finalVars)])) {
      if (name === 'BUILD_ID') continue;
      if (liveVars[name] !== finalVars[name]) changes.push({ name, from: liveVars[name], to: finalVars[name] });
    }
  }
  return { vars, finalVars, kept: kept.sort(), changes, problems };
}

/**
 * What --execute must know about the live Worker before it deploys (a dry run only warns): the version serving
 * traffic (the rollback target), that version's vars (unread, a var that exists only on the live Worker would be
 * dropped without notice) and the D1 migration status (unknown, a pending migration could ship unapplied).
 * @param {{ prevVersion: string|null, liveVarsRead: boolean, migrationsKnown: boolean }} o
 * @returns {string[]} reasons to refuse (empty = the live state is known)
 */
export function unknownLiveState({ prevVersion, liveVarsRead, migrationsKnown }) {
  const out = [];
  if (!prevVersion) out.push('no live version listed (wrangler deployments list): no rollback target');
  else if (!liveVarsRead) out.push(`the vars of the live version ${prevVersion} could not be read: a var that exists only on the live Worker would be dropped`);
  if (!migrationsKnown) out.push('D1 migration status unknown (wrangler d1 migrations list failed): a pending migration could ship unapplied');
  return out;
}

/** `--var NAME:value` arguments, sorted by name (wrangler splits on the first colon). */
export function varFlags(vars) {
  return Object.keys(vars)
    .sort()
    .flatMap((k) => ['--var', `${k}:${vars[k]}`]);
}

async function git(args) {
  const r = await run('git', args, { echo: false });
  return r.code === 0 ? r.out.trim() : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['execute', 'dry-run', 'migrate', 'skip-build', 'allow-dirty', 'yes']);
  if (args.execute && args['dry-run']) throw new Error('choose --dry-run or --execute');
  const EXECUTE = !!args.execute;
  if (EXECUTE && args['skip-build']) throw new Error('--skip-build is for dry runs only: --execute always rebuilds');
  const origin = typeof args.origin === 'string' ? args.origin : ORIGINS.mainnet;
  const checks = new Checks();
  const report = { startedAt: new Date().toISOString(), execute: EXECUTE, worker: WORKER_NAMES.mainnet };
  head(`HOTFIX ${WORKER_NAMES.mainnet} (mainnet Worker) · ${EXECUTE ? 'EXECUTE' : 'DRY RUN (nothing is deployed or changed)'}`);

  // ---------------------------------------------------------------------------------------------- preflight
  head('1 · preflight');
  const who = await whoamiMatches();
  checks.check(who, 'wrangler logged in to the AtlasPad Cloudflare account', `account id ${expectedAccountId()}`, WRANGLER_LOGIN_FIX);
  const dep = readDeploy('mainnet');
  checks.check(!!dep, 'deploy/mainnet.json present', dep ? `alt ${dep.alt ?? '—'} · program ${dep.programId ?? '—'}` : 'mainnet is not live yet: use scripts/go-mainnet.mjs');
  let cfg = null;
  try {
    cfg = readWranglerConfig();
  } catch (e) {
    checks.fail('wrangler.jsonc', e.message);
  }
  const ep = cfg ? envProblems('mainnet', cfg) : [];
  for (const p of ep) checks.fail('wrangler.jsonc env.mainnet', p);
  if (cfg && !ep.length) checks.pass('wrangler.jsonc env.mainnet', `name ${WORKER_NAMES.mainnet}, CLUSTER mainnet, __CS_DEV_ENDPOINTS__ false`);
  const d1 = cfg ? configuredD1Id('mainnet', cfg) : null;
  checks.check(!!d1 && d1 !== D1_PLACEHOLDERS.mainnet, 'D1 cornershop-mainnet id in wrangler.jsonc', d1 ?? 'missing', 'commit the wrangler.jsonc that go-mainnet wrote (database_id)');
  const head_ = await git(['rev-parse', 'HEAD']);
  const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])) ?? '';
  report.git = { commit: head_, dirty: !!dirty };
  if (!dirty) checks.pass('git tree clean', head_?.slice(0, 12));
  else if (EXECUTE && !args['allow-dirty']) checks.fail('git tree has uncommitted changes', dirty.split('\n').slice(0, 3).join(' | '), 'commit first (or pass --allow-dirty deliberately)');
  else checks.warn('git tree has uncommitted changes', dirty.split('\n').slice(0, 3).join(' | '));

  let prevVersion = null;
  let live = null;
  if (who) {
    try {
      const names = await secretNames('mainnet');
      const required = envConfig('mainnet', cfg ?? {})?.secrets?.required ?? [];
      const missing = required.filter((n) => !names?.includes(n));
      if (!names) checks.fail(`${WORKER_NAMES.mainnet} Worker`, 'does not exist: mainnet is not live yet (scripts/go-mainnet.mjs)');
      else if (missing.length) checks.fail('required secrets on the Worker', `missing: ${missing.join(', ')}`, `set them first (node scripts/lib/secretPut.mjs NAME --env mainnet --from … --execute)`);
      else checks.pass('required secrets on the Worker (names)', required.join(', ') || 'none declared');
      if (names?.includes('DEV_FAUCET_SECRET')) checks.fail('Worker secrets', 'DEV_FAUCET_SECRET is set on mainnet (H6)', 'npx wrangler secret delete DEV_FAUCET_SECRET --env mainnet');
    } catch (e) {
      checks.fail('Worker secrets (names)', e.message);
    }
    const pm = await pendingMigrations('mainnet');
    if (!pm.ok) checks.warn('D1 migrations status', pm.error);
    else if (!pm.pending.length) checks.pass('D1 migrations', 'up to date');
    else if (args.migrate) checks.warn('D1 migrations pending', `${pm.pending.join(', ')} (applied before the deploy: --migrate)`);
    else checks.fail('D1 migrations pending', pm.pending.join(', '), 'review them, then re-run with --migrate (forward-only; applied before the deploy)');
    report.pendingMigrations = pm.ok ? pm.pending : null;
    prevVersion = currentVersionId(await deploymentsList('mainnet'));
    if (prevVersion) {
      const v = await wrangler(['versions', 'view', prevVersion, '--env', 'mainnet', '--json']);
      try {
        if (v.code !== 0) throw new Error((v.stderr || v.stdout).trim().split('\n').pop());
        live = liveVarsOf(JSON.parse(v.stdout.slice(v.stdout.indexOf('{'))));
        checks.pass('live version (rollback target)', `${prevVersion} · ${Object.keys(live.vars).length} vars`);
      } catch (e) {
        checks.warn('live vars', `could not read version ${prevVersion} (${String(e.message).slice(0, 120)}): vars come from deploy/mainnet.json + wrangler.jsonc only`);
      }
    } else checks.warn('live version', 'no deployment listed: no rollback target known');
  }
  report.rollbackTo = prevVersion;
  // --execute never deploys blind: an unread live state is a refusal, not a warning (the dry run shows the warnings).
  if (EXECUTE && who) for (const r of unknownLiveState({ prevVersion, liveVarsRead: !!live, migrationsKnown: report.pendingMigrations !== null })) checks.fail('live state unknown', r, 'fix wrangler access (npx wrangler login) and re-run');

  // ---------------------------------------------------------------------------------------------- build
  head('2 · build:mainnet + check-bundle');
  if (args['skip-build']) checks.warn('build', 'skipped (--skip-build, dry run)');
  else {
    const b = await run('npm', ['run', 'build:mainnet'], { echo: false });
    if (b.code !== 0) checks.fail('build:mainnet', b.out.trim().split('\n').slice(-3).join(' | '));
    else {
      checks.pass('build:mainnet', 'dist-mainnet');
      const cb = await run('node', ['scripts/check-bundle.mjs', 'dist-mainnet', '--cluster', 'mainnet', '--build-worker'], { echo: false });
      if (cb.code === 0) checks.pass('check-bundle mainnet (client + Worker dry-run bundle)', 'budgets, leak scan, no devnet-only code');
      else checks.fail('check-bundle mainnet', cb.out.split('\n').filter((l) => l.startsWith('✗')).slice(0, 4).join(' | '));
    }
  }

  // ---------------------------------------------------------------------------------------------- vars plan
  head('3 · vars (every var preserved)');
  const { buildId } = await import('./deploy-devnet.mjs');
  const plan = planVars({ configVars: envConfig('mainnet', cfg ?? {})?.vars ?? {}, deploy: dep, liveVars: live?.vars ?? null, liveJsonVars: live?.json ?? [], buildId: buildId(join(ROOT, 'dist-mainnet')) });
  for (const p of plan.problems) checks.fail('vars', p);
  for (const n of plan.kept) checks.warn(`var only on the live Worker: ${n}`, 'kept (add it to wrangler.jsonc env.mainnet.vars to make it permanent)');
  for (const c of plan.changes) info(`var change ${c.name}: ${JSON.stringify(c.from ?? null)} → ${JSON.stringify(c.to ?? null)}`);
  if (!plan.problems.length) checks.pass('vars plan', Object.keys(plan.vars).sort().join(', ') + (plan.changes.length ? ` · ${plan.changes.length} change(s) vs live` : ' · no change vs live'));
  report.vars = { passed: Object.keys(plan.vars).sort(), kept: plan.kept, changes: plan.changes };

  const argv = ['deploy', '--env', 'mainnet', ...varFlags(plan.vars)];
  const green = checks.summary(`hotfix preflight (${EXECUTE ? 'execute' : 'dry run'})`);
  console.log(`\n  deploy command: npx wrangler ${argv.join(' ')}`);
  console.log(`  rollback:       npx wrangler rollback ${prevVersion ?? '<previous version id>'} --env mainnet`);
  const finish = (code) => {
    report.checks = checks.toJSON();
    report.finishedAt = new Date().toISOString();
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `hotfix-mainnet-${report.startedAt.replace(/[-:]/g, '').slice(0, 15)}.json`), JSON.stringify(report, null, 2));
    process.exit(code);
  };
  if (!EXECUTE) {
    console.log('\nDry run complete. Nothing was deployed or changed.');
    return finish(green ? 0 : 1);
  }

  // ================================================================================================ EXECUTE
  if (!green) throw new Error('refusing to deploy: preflight has failures (fix every ✗)');
  if (!args.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('refusing to deploy without an interactive terminal (or pass --yes)');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`\n  Deploy commit ${head_?.slice(0, 12) ?? '?'}${dirty ? ' (+ uncommitted changes)' : ''} to ${WORKER_NAMES.mainnet}? Type HOTFIX to continue: `)).trim();
    rl.close();
    if (a !== 'HOTFIX') throw new Error('not confirmed; nothing was deployed');
  }
  if (args.migrate && report.pendingMigrations?.length) {
    head('4 · D1 migrations');
    info(await d1MigrateRemote('mainnet'));
  }
  head('5 · wrangler deploy --env mainnet');
  const d = await wrangler(argv, { echo: true, timeoutMs: 600_000 });
  report.deployed = d.code === 0;
  if (d.code !== 0) {
    checks.fail('wrangler deploy', `exit ${d.code}: the previous version is still live`);
    return finish(1);
  }
  ok(`deployed ${WORKER_NAMES.mainnet} (BUILD_ID ${plan.vars.BUILD_ID})`);

  head('6 · smoke');
  let sm = { code: 1 };
  for (let i = 0; i < 6 && sm.code !== 0; i++) {
    if (i) await sleep(10_000);
    sm = await run('node', ['scripts/smoke.mjs', origin, '--cluster', 'mainnet', '--json']);
  }
  report.smoke = sm.code === 0;
  if (sm.code === 0) checks.pass('smoke', `green on ${origin}`);
  else {
    checks.fail('smoke', `red on ${origin}`);
    warn(`ROLL BACK NOW if users are affected: npx wrangler rollback ${prevVersion ?? '<previous version id>'} --env mainnet`);
  }
  finish(sm.code === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}
