#!/usr/bin/env node
/**
 * Devnet deploy, end to end (INTEGRATION §10.2 `deploy-devnet`). Run it through scripts/deploy-devnet.sh.
 *
 *   bash scripts/deploy-devnet.sh                      # DRY RUN: preflight + plan; sends nothing, changes nothing
 *   bash scripts/deploy-devnet.sh --execute            # do everything that is not done yet (idempotent)
 *   bash scripts/deploy-devnet.sh --execute --only deploy,secrets,smoke     # just ship the Worker
 *   options: --from <step> · --only <a,b> · --skip <a,b> · --upgrade-program · --resync-secrets
 *            --crank-sol 0.2 · --faucet-sol 3 · --reserve-sol 0.5 · --build (also build in a dry run)
 *
 * Steps: preflight → fund → program → config → alt → record → d1 → roles → build → secrets → deploy → smoke
 *  - preflight  Node ≥ 22.18, solana CLI, wrangler on the AtlasPad Cloudflare account (by id; CS_CLOUDFLARE_ACCOUNT_ID
 *               overrides), .env.server NAMES, keys (crank/faucet/hmac created on --execute), devnet genesis,
 *               wrangler.jsonc env.devnet shape (H4/H6), migrations present.
 *  - fund       deployer balance vs what the remaining steps need; airdrops on --execute; faucet URL when short.
 *  - program    deploys target/deploy-devnet/shop_vault.so via programs/shop-vault/scripts/devnet-deploy.sh if missing;
 *               otherwise checks the deployed bytes equal the local devnet artifact and the upgrade authority.
 *  - config     init-config (60 s window).            - alt   create-alt (verifies/records the frozen ALT).
 *  - record     deploy/devnet.json: deployer/crank/faucet pubkeys.
 *  - d1         D1 cornershop-devnet: create if missing, replace __D1_DEVNET_ID__, apply migrations --remote.
 *  - roles      top up the crank (0.2) and the dev faucet (3) from the deployer, best effort above a reserve.
 *  - build      build:devnet (VITE_CLUSTER=devnet VITE_TEST_WALLET=1 → dist-devnet) + check-bundle.
 *  - secrets    the §1.6 devnet set in ONE `wrangler secret bulk --env devnet` (stdin JSON; names printed only).
 *               BEFORE deploy: env.devnet declares `secrets.required`, and wrangler refuses to deploy while a required
 *               secret is unset. On a brand-new Worker, `secret bulk` first creates an empty placeholder Worker (wrangler
 *               behaviour); the deploy right after replaces it. No secrets file is ever written (H2).
 *  - deploy     `wrangler deploy --env devnet --var ALT_ADDRESS:… --var BUILD_ID:…` (ONLY cornershop-devnet, H4).
 *  - smoke      scripts/smoke.mjs against https://cornershop-devnet.tiejiucai.workers.dev.
 * Nothing here prints a secret; CLI output is redacted line by line.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSol } from './lib/amounts.mjs';
import { readDeploy, writeDeploy } from './lib/deployJson.mjs';
import { alchemySourceName, missingEnv } from './lib/env.mjs';
import { ensureKey, ensureRandomKey, keyPath, keypair, permissionProblem, pubkey } from './lib/keys.mjs';
import { Checks, fmtSol, head, info, ok, parseArgs, sleep, warn } from './lib/log.mjs';
import { CONFIG_PDA, explorerTx, OUT_DIR, ORIGINS, PROGRAM_DIR, PUBLIC_RPC, ROOT, WORKER_NAMES } from './lib/paths.mjs';
import { run } from './lib/proc.mjs';
import { artifactInfo, deployedProgram, programDeployCost } from './lib/program.mjs';
import { assertGenesis, getAccount, getBalance, label, rentExempt } from './lib/rpc.mjs';
import { collectSecrets, putSecretsBulk } from './lib/secretPut.mjs';
import { d1Ensure, d1MigrateRemote, d1Uuid, envConfig, envProblems, expectedAccountId, pendingMigrations, readWranglerConfig, replaceD1Placeholder, secretNames, whoamiMatches, wrangler, WRANGLER_LOGIN_FIX } from './lib/wrangler.mjs';

export const STEPS = ['preflight', 'fund', 'program', 'config', 'alt', 'record', 'd1', 'roles', 'build', 'secrets', 'deploy', 'smoke'];

/** Which steps run for --only / --from / --skip (preflight always runs). */
export function selectSteps({ only, from, skip } = {}) {
  const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  for (const s of [...list(only), ...list(skip), ...list(from)]) if (!STEPS.includes(s)) throw new Error(`unknown step ${s} (steps: ${STEPS.join(', ')})`);
  let steps = STEPS.slice();
  if (only) steps = steps.filter((s) => list(only).includes(s));
  if (from) steps = steps.slice(Math.max(0, steps.indexOf(list(from)[0])));
  if (skip) steps = steps.filter((s) => !list(skip).includes(s));
  return ['preflight', ...steps.filter((s) => s !== 'preflight')];
}

/** BUILD_ID = <UTC yyyymmddHHMM>-<sha256(dist index.html + worker sources)[0..8]>. */
export function buildId(distDir) {
  const h = createHash('sha256');
  const idx = join(distDir, 'index.html');
  if (existsSync(idx)) h.update(readFileSync(idx));
  const wdir = join(ROOT, 'worker');
  if (existsSync(wdir)) for (const f of readdirSync(wdir, { recursive: true }).map(String).sort()) if (/\.ts$/.test(f)) h.update(readFileSync(join(wdir, f)));
  const t = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return `${t}-${h.digest('hex').slice(0, 8)}`;
}

function packageScripts() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    return {};
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['execute', 'upgrade-program', 'resync-secrets', 'build']);
  const EXECUTE = !!args.execute;
  const steps = selectSteps(args);
  const want = (s) => steps.includes(s);
  const CRANK = parseSol(args['crank-sol'] ?? '0.2');
  const FAUCET = parseSol(args['faucet-sol'] ?? '3');
  const RESERVE = parseSol(args['reserve-sol'] ?? '0.5');
  const url = PUBLIC_RPC.devnet; // scripts never use the provider key (lib/rpc.mjs)
  const checks = new Checks();
  const report = { startedAt: new Date().toISOString(), execute: EXECUTE, steps, results: {} };
  const blocked = new Set(); // steps that cannot run (reason recorded in checks)

  head(`deploy-devnet · ${label(url)} · ${EXECUTE ? 'EXECUTE' : 'DRY RUN (nothing is sent or changed)'} · steps: ${steps.join(' → ')}`);

  // ------------------------------------------------------------------------------------------------ preflight
  head('0 · preflight');
  const [maj, min] = process.versions.node.split('.').map(Number);
  checks.check(maj > 22 || (maj === 22 && min >= 18), 'Node ≥ 22.18', `node ${process.versions.node}`, 'install Node 22.18+ (type stripping)');
  const solana = await run('solana', ['--version'], { echo: false, timeoutMs: 20_000 });
  checks.check(solana.code === 0, 'solana CLI on PATH', solana.out.trim().split('\n')[0], 'install the Agave CLI (RUNBOOK "Toolchain")');
  checks.check(existsSync(join(PROGRAM_DIR, 'client', 'node_modules', '@solana', 'web3.js')), 'shop-vault client deps installed', undefined, '(cd programs/shop-vault/client && npm ci)');
  const who = await whoamiMatches();
  checks.check(who, 'wrangler logged in to the AtlasPad Cloudflare account', `account id ${expectedAccountId()}`, WRANGLER_LOGIN_FIX);
  const missing = missingEnv(['GOOGLE_SERVER_KEY', alchemySourceName('devnet')]);
  checks.check(!missing.length, '.env.server has the devnet server keys', missing.length ? `missing: ${missing.join(', ')}` : 'GOOGLE_SERVER_KEY, ALCHEMY_API_KEY (names only)');
  for (const k of ['devnet-deployer', 'devnet-attestor', 'devnet-guardian', 'shop-vault-program']) {
    try {
      const pk = pubkey(k);
      const perm = permissionProblem(k);
      if (perm) checks.warn(`.keys/${k}.json permissions`, perm);
      checks.pass(`.keys/${k}.json`, pk);
    } catch (e) {
      checks.fail(`.keys/${k}.json`, e.message);
    }
  }
  for (const k of ['devnet-crank', 'devnet-faucet']) {
    if (existsSync(keyPath(k))) checks.pass(`.keys/${k}.json`, pubkey(k));
    else if (EXECUTE) checks.pass(`.keys/${k}.json created`, ensureKey(k).pubkey);
    else checks.warn(`.keys/${k}.json`, 'missing; created on --execute');
  }
  if (existsSync(keyPath('devnet-hmac.key'))) checks.pass('.keys/devnet-hmac.key', 'present');
  else if (EXECUTE) {
    ensureRandomKey('devnet-hmac.key');
    checks.pass('.keys/devnet-hmac.key created', '32 random bytes');
  } else checks.warn('.keys/devnet-hmac.key', 'missing; created on --execute');
  try {
    await assertGenesis(url, 'devnet');
    checks.pass('RPC genesis is devnet', label(url));
  } catch (e) {
    checks.fail('RPC genesis', e.message);
  }
  let cfg = null;
  try {
    cfg = readWranglerConfig();
  } catch (e) {
    checks.fail('wrangler.jsonc parses', e.message);
  }
  const wp = cfg ? envProblems('devnet', cfg) : ['wrangler.jsonc unreadable'];
  if (wp.length) {
    for (const p of wp) checks.warn('wrangler.jsonc env.devnet', p);
    for (const s of ['d1', 'build', 'deploy', 'secrets', 'smoke']) blocked.add(s);
    info('Worker steps (d1, build, deploy, secrets, smoke) wait for BACKEND\'s env.devnet (INTEGRATION §1.4)');
  } else checks.pass('wrangler.jsonc env.devnet', `name ${WORKER_NAMES.devnet}, CLUSTER devnet, __CS_DEV_ENDPOINTS__ true`);
  const migDir = join(ROOT, envConfig('devnet', cfg ?? {})?.d1_databases?.[0]?.migrations_dir ?? 'migrations');
  if (!existsSync(migDir) || !readdirSync(migDir).some((f) => f.endsWith('.sql'))) {
    checks.warn('D1 migrations', `${migDir.replace(ROOT + '/', '')} has no .sql files yet (BACKEND)`);
    blocked.add('d1');
  } else checks.pass('D1 migrations present', readdirSync(migDir).filter((f) => f.endsWith('.sql')).join(', '));
  if (checks.failed.length) {
    checks.summary('preflight');
    process.exit(1);
  }

  const deployerPk = pubkey('devnet-deployer');
  const dep0 = readDeploy('devnet') ?? {};
  const art = artifactInfo('devnet');
  let prog = await deployedProgram(url);
  const configAcc = await getAccount(url, CONFIG_PDA);

  // ------------------------------------------------------------------------------------------------ fund
  if (want('fund')) {
    head('1 · fund');
    let need = 0n;
    if (!prog.exists && art) need += (await programDeployCost(url, art.bytes, rentExempt)).peak;
    if (!configAcc) need += (await rentExempt(url, 256)) + 10_000n;
    if (!dep0.alt) need += (await rentExempt(url, 56 + 14 * 32)) + 20_000n;
    const crankBal = existsSync(keyPath('devnet-crank')) ? await getBalance(url, pubkey('devnet-crank')) : 0n;
    const faucetBal = existsSync(keyPath('devnet-faucet')) ? await getBalance(url, pubkey('devnet-faucet')) : 0n;
    const roles = (CRANK > crankBal ? CRANK - crankBal : 0n) + (FAUCET > faucetBal ? FAUCET - faucetBal : 0n);
    let bal = await getBalance(url, deployerPk);
    info(`deployer ${deployerPk}: ${fmtSol(bal)} · chain steps need ${fmtSol(need)} · roles top-up ${fmtSol(roles)} · reserve ${fmtSol(RESERVE)}`);
    if (bal < need + roles + RESERVE && EXECUTE) {
      const { airdrop } = await import('./fund-devnet.mjs');
      bal = await airdrop({ execute: true, target: need + roles + RESERVE, max: 8 });
    }
    if (bal < need) {
      checks.fail('deployer funded for the chain steps', `${fmtSol(bal)} < ${fmtSol(need)}`, 'fund it (RUNBOOK "Funding devnet")');
      for (const s of ['program', 'config', 'alt']) blocked.add(s);
    } else checks.pass('deployer funded for the chain steps', fmtSol(bal));
    if (bal < need + roles + RESERVE) {
      checks.warn('deployer below the full target', `roles (crank ${fmtSol(CRANK)}, faucet ${fmtSol(FAUCET)}) will be topped up only above the ${fmtSol(RESERVE)} reserve`);
      console.log(`\n  Fund by hand: https://faucet.solana.com (network: devnet; GitHub login gives more) → ${deployerPk}\n`);
    }
    report.results.fund = { deployer: deployerPk, balance: bal.toString(), need: need.toString(), roles: roles.toString() };
  }

  // ------------------------------------------------------------------------------------------------ program
  if (want('program') && !blocked.has('program')) {
    head('2 · program');
    if (!art || !art.hasMarker || art.hasOtherMarker) {
      checks.fail('devnet artifact', 'target/deploy-devnet/shop_vault.so missing or not a devnet build', 'programs/shop-vault/scripts/build.sh');
    } else if (!prog.exists) {
      if (!EXECUTE) info(`would deploy ${art.bytes} B devnet build (sha256 ${art.sha256.slice(0, 16)}…) with programs/shop-vault/scripts/devnet-deploy.sh`);
      else {
        const r = await run('bash', [join(PROGRAM_DIR, 'scripts', 'devnet-deploy.sh')], { cwd: PROGRAM_DIR, env: { RPC_URL: PUBLIC_RPC.devnet } });
        prog = await deployedProgram(url);
        if (checks.check(r.code === 0 && prog.exists, 'program deployed', prog.exists ? 'devnet-deploy.sh OK' : `exit ${r.code}`)) report.results.program = { deployed: true }; // a deploy record (lib/evidence.mjs)
      }
    } else if (args['upgrade-program'] && prog.deployedSha256(art.bytes) !== art.sha256) {
      if (!EXECUTE) info('would upgrade the program (UPGRADE=1 devnet-deploy.sh)');
      else {
        const r = await run('bash', [join(PROGRAM_DIR, 'scripts', 'devnet-deploy.sh')], { cwd: PROGRAM_DIR, env: { RPC_URL: PUBLIC_RPC.devnet, UPGRADE: '1' } });
        prog = await deployedProgram(url);
        if (checks.check(r.code === 0, 'program upgraded', `exit ${r.code}`)) report.results.program = { deployed: true, upgrade: true };
      }
    }
    if (prog.exists) {
      checks.check(prog.executable, 'program executable', undefined);
      checks.check(prog.upgradeAuthority === deployerPk, 'upgrade authority = devnet deployer', prog.upgradeAuthority ?? 'immutable');
      const same = art && prog.deployedSha256(art.bytes) === art.sha256;
      if (same) checks.pass('deployed bytes = local devnet artifact', `${art.bytes} B, sha256 ${art.sha256.slice(0, 16)}…`);
      else checks.warn('deployed bytes differ from target/deploy-devnet', 'rebuild or pass --upgrade-program');
      if (EXECUTE && same) writeDeploy('devnet', { programDataSha256: art.sha256, programSoBytes: art.bytes });
    }
  }

  // ------------------------------------------------------------------------------------------------ config
  if (want('config') && !blocked.has('config')) {
    head('3 · config');
    if (!prog.exists) checks.warn('config', 'program not deployed yet');
    else {
      const { initConfig } = await import('./init-config.mjs');
      const r = await initConfig({
        cluster: 'devnet',
        url,
        payer: await keypair('devnet-deployer'),
        attestor: pubkey('devnet-attestor'),
        guardian: pubkey('devnet-guardian'),
        governance: deployerPk,
        windowSecs: Number(args.window ?? 60),
        execute: EXECUTE,
      });
      if (r.problems.length) for (const p of r.problems) checks.fail('Config', p);
      else checks.pass('Config', r.status === 'initialized' ? `initialised — ${explorerTx(r.signature, 'devnet')}` : r.status);
    }
  }

  // ------------------------------------------------------------------------------------------------ alt
  if (want('alt') && !blocked.has('alt')) {
    head('4 · alt');
    const { createAlt } = await import('./create-alt.mjs');
    const r = await createAlt({ cluster: 'devnet', url, authority: await keypair('devnet-deployer'), execute: EXECUTE });
    if (r.problems.length) for (const p of r.problems) checks.fail('ALT', p);
    else if (r.alt) checks.pass('ALT', `${r.alt} (${r.status}, frozen, 14 keys)`);
    else info(`ALT: ${r.plan ?? r.status}`);
  }

  // ------------------------------------------------------------------------------------------------ record
  if (want('record')) {
    head('5 · record deploy/devnet.json');
    const patch = { deployer: deployerPk };
    if (existsSync(keyPath('devnet-crank'))) patch.crank = pubkey('devnet-crank');
    if (existsSync(keyPath('devnet-faucet'))) patch.faucet = pubkey('devnet-faucet');
    if (EXECUTE) writeDeploy('devnet', patch);
    const d = readDeploy('devnet') ?? {};
    for (const k of ['programId', 'configPda', 'alt', 'attestor', 'guardian', 'governance', 'claimWindowSecs']) {
      if (d[k] === undefined) checks.warn(`deploy/devnet.json.${k}`, 'not recorded yet');
    }
    checks.pass('deploy/devnet.json', `alt ${d.alt ?? '—'} · attestor ${d.attestor ?? '—'}`);
  }

  // ------------------------------------------------------------------------------------------------ d1
  if (want('d1') && !blocked.has('d1')) {
    head('6 · D1 cornershop-devnet');
    let uuid = await d1Uuid('devnet');
    if (!uuid && EXECUTE) uuid = (await d1Ensure('devnet')).uuid;
    if (!uuid) info('would create D1 cornershop-devnet');
    else {
      checks.pass('D1 cornershop-devnet exists', uuid);
      if (EXECUTE && replaceD1Placeholder('devnet', uuid)) ok('wrangler.jsonc: __D1_DEVNET_ID__ replaced with the database id');
      const pm = await pendingMigrations('devnet');
      if (!pm.ok) checks.warn('D1 migrations status', pm.error);
      else if (pm.pending.length) {
        if (EXECUTE) checks.pass('D1 migrations applied', await d1MigrateRemote('devnet'));
        else info(`would apply ${pm.pending.join(', ')}`);
      } else checks.pass('D1 migrations', 'up to date');
    }
  }

  // ------------------------------------------------------------------------------------------------ roles
  if (want('roles')) {
    head('7 · fund crank + dev faucet');
    if (!existsSync(keyPath('devnet-crank')) || !existsSync(keyPath('devnet-faucet'))) checks.warn('roles', 'crank/faucet keys not created yet (run with --execute)');
    else {
      const { web3, connection, buildTx, simulateAndSend } = await import('./lib/web3.mjs');
      const deployer = await keypair('devnet-deployer');
      let avail = (await getBalance(url, deployerPk)) - RESERVE;
      const ixs = [];
      for (const [role, want] of [['crank', CRANK], ['faucet', FAUCET]]) {
        const pk = pubkey(`devnet-${role}`);
        const have = await getBalance(url, pk);
        let top = want > have ? want - have : 0n;
        if (top > avail) top = avail > 0n ? avail : 0n;
        avail -= top;
        info(`${role} ${pk}: ${fmtSol(have)} (target ${fmtSol(want)})${top ? ` → +${fmtSol(top)}` : ''}`);
        if (top > 0n) ixs.push(web3.SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: new web3.PublicKey(pk), lamports: top }));
        if (have + top < want) checks.warn(`${role} below target`, `${fmtSol(have + top)} < ${fmtSol(want)}${role === 'faucet' ? ' (airdrops need ≥ 0.3 SOL in the faucet)' : ''}`);
      }
      if (ixs.length) {
        const conn = connection(url);
        const r = await simulateAndSend(conn, await buildTx(conn, deployer.publicKey, ixs, [deployer]), { execute: EXECUTE, label: 'fund crank/faucet' });
        if (r.simulatedOnly) info('top-up simulated OK (dry run)');
        else checks.pass('crank/faucet topped up', explorerTx(r.signature, 'devnet'));
      } else checks.pass('crank/faucet', 'nothing to top up');
    }
  }

  // ------------------------------------------------------------------------------------------------ build
  const dist = join(ROOT, 'dist-devnet');
  if (want('build') && !blocked.has('build')) {
    head('8 · build:devnet + check-bundle');
    if (!EXECUTE && !args.build) info('would run build:devnet (VITE_CLUSTER=devnet VITE_TEST_WALLET=1 → dist-devnet) and check-bundle');
    else {
      const scripts = packageScripts();
      const r = scripts['build:devnet']
        ? await run('npm', ['run', 'build:devnet'])
        : await (async () => {
            const tc = await run('npm', ['run', 'typecheck']);
            if (tc.code !== 0) return tc;
            return run('npx', ['--no-install', 'vite', 'build', '--outDir', 'dist-devnet', '--emptyOutDir'], { env: { VITE_CLUSTER: 'devnet', VITE_TEST_WALLET: '1' } });
          })();
      checks.check(r.code === 0, 'build:devnet', r.code === 0 ? 'dist-devnet' : `exit ${r.code}`);
      if (r.code === 0) {
        const cb = await run('node', ['scripts/check-bundle.mjs', 'dist-devnet', '--cluster', 'devnet']);
        checks.check(cb.code === 0, 'check-bundle dist-devnet', cb.code === 0 ? 'budgets + leak scan green' : 'see output above');
      } else blocked.add('deploy');
    }
  }

  // ------------------------------------------------------------------------------------------------ secrets
  if (want('secrets') && !blocked.has('secrets')) {
    head('9 · secrets (wrangler secret bulk --env devnet, stdin)');
    const { values, missingRequired, missingOptional, sources } = collectSecrets('devnet');
    const createdOnExecute = new Set(['CRANK_SECRET', 'HMAC_KEY', 'DEV_FAUCET_SECRET']);
    for (const s of sources) info(`${s.name.padEnd(22)} ← ${s.source}${s.present ? '' : s.required ? '  MISSING' : '  (optional, not set)'}`);
    const hardMissing = missingRequired.filter((n) => EXECUTE || !createdOnExecute.has(n));
    if (hardMissing.length) {
      checks.fail('secret sources', `missing: ${hardMissing.join(', ')}`);
      blocked.add('deploy');
    } else {
      if (missingRequired.length) info(`${missingRequired.join(', ')}: key files are created on --execute`);
      const existing = await secretNames('devnet');
      if (existing === null) info('cornershop-devnet does not exist yet: `secret bulk` creates it (empty placeholder) and the deploy step replaces it');
      const names = Object.keys(values).filter((n) => args['resync-secrets'] || !existing?.includes(n));
      const stray = (existing ?? []).filter((n) => !sources.some((s) => s.name === n));
      for (const n of stray) checks.warn('unexpected secret on cornershop-devnet', `${n} (remove: npx wrangler secret delete ${n} --env devnet)`);
      if (!names.length && !missingRequired.length) checks.pass('secrets', `all ${Object.keys(values).length} present${missingOptional.length ? ` (optional unset: ${missingOptional.join(', ')})` : ''}`);
      else if (!EXECUTE) info(`would set: ${[...names, ...missingRequired].join(', ')}`);
      else {
        const subset = Object.fromEntries(names.map((n) => [n, values[n]]));
        const set = await putSecretsBulk(subset, 'devnet');
        checks.pass('secrets set (names)', set.join(', '));
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ deploy
  if (want('deploy') && !blocked.has('deploy')) {
    head('10 · wrangler deploy --env devnet');
    const d = readDeploy('devnet') ?? {};
    const e = envConfig('devnet');
    const problems = [];
    if (e?.name !== WORKER_NAMES.devnet) problems.push(`env.devnet.name must be ${WORKER_NAMES.devnet} (H4)`);
    if (!d.alt) problems.push('deploy/devnet.json has no alt');
    if (!existsSync(join(dist, 'index.html'))) {
      if (EXECUTE) problems.push('dist-devnet/index.html missing (run the build step)');
      else info('dist-devnet is built by the build step on --execute');
    }
    if (checks.failed.length) problems.push('earlier steps failed');
    if (problems.length) for (const p of problems) checks.fail('deploy refused', p);
    else {
      const id = buildId(dist);
      const argv = ['deploy', '--env', 'devnet', '--var', `ALT_ADDRESS:${d.alt}`, '--var', `BUILD_ID:${id}`];
      if (!EXECUTE) info(`would run: npx wrangler ${argv.join(' ')}`);
      else {
        const r = await wrangler(argv, { echo: true, timeoutMs: 600_000 });
        const named = (r.stdout + r.stderr).includes(WORKER_NAMES.devnet);
        checks.check(r.code === 0 && named, `deployed ${WORKER_NAMES.devnet}`, r.code === 0 ? `BUILD_ID ${id}` : `exit ${r.code}`);
        report.results.deploy = { buildId: id, ok: r.code === 0 };
      }
    }
  }


  // ------------------------------------------------------------------------------------------------ smoke
  if (want('smoke') && !blocked.has('smoke')) {
    head('11 · smoke');
    if (!EXECUTE && !report.results.deploy) info(`would run: node scripts/smoke.mjs ${ORIGINS.devnet} --cluster devnet`);
    else {
      await sleep(3000);
      const r = await run('node', ['scripts/smoke.mjs', ORIGINS.devnet, '--cluster', 'devnet']);
      checks.check(r.code === 0, 'smoke', r.code === 0 ? 'green' : 'see output above');
    }
  }

  const green = checks.summary(`deploy-devnet (${EXECUTE ? 'execute' : 'dry run'})`);
  if (blocked.size) warn(`not run: ${[...blocked].join(', ')}`);
  report.checks = checks.toJSON();
  report.finishedAt = new Date().toISOString();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `deploy-devnet-${report.startedAt.replace(/[-:]/g, '').slice(0, 15)}.json`), JSON.stringify(report, null, 2));
  process.exit(green ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}
