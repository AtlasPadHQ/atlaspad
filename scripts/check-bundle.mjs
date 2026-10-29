#!/usr/bin/env node
/**
 * Bundle budgets, chunking rules, leak scan and devnet-only proofs (INTEGRATION §6, §8, §10.2; H2, H3, H6).
 *
 *   node scripts/check-bundle.mjs dist-devnet  --cluster devnet
 *   node scripts/check-bundle.mjs dist-mainnet --cluster mainnet --worker .wrangler/check-mainnet [--build-worker]
 *   options: --json (write scripts/out/check-bundle-<cluster>.json) · --cluster demo (leak scan only, no budgets)
 *
 * Checks
 *  - Initial JS = entry chunk(s) from index.html + everything they import STATICALLY (dynamic import() excluded),
 *    gzip ≤ 170 KB; initial CSS (local stylesheets linked from index.html) gzip ≤ 32 KB.
 *  - pump SDK in its own chunk (≤ 450 KB gz) and never on the initial path; pump-swap (AMM) never initial;
 *    chain core (web3.js + shop-vault client) ≤ 160 KB gz and never initial; the devnet test wallet never initial.
 *  - Leaks: no value from .env.server or .keys/* (compared in memory, several encodings, plus raw seeds), no
 *    `g.alchemy.com` / `helius-rpc.com` URL, no server secret NAMES in client files. The browser Maps key is public.
 *  - Mainnet: none of `cs-devnet-test-wallet-v1`, `Devnet Test Wallet`, `/api/dev/`, `devCode`, `__csTestWallet`,
 *    `installDevTools` in any client file; with --worker: no `/api/dev/`, `screenVerifier`, `DEV_FAUCET` in the Worker
 *    bundle (`wrangler deploy --dry-run --env mainnet --outdir .wrangler/check-mainnet`, or --build-worker).
 *  - Mainnet: terms.html and privacy.html exist and carry no prototype wording ("prototype", "simulated", "no real
 *    transaction", "never asked to sign", "fictional").
 * Prints file names, sizes and secret NAMES only. Exit 1 on any failure.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, posix, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Checks, fatal, head, info, parseArgs } from './lib/log.mjs';
import { OUT_DIR, ROOT } from './lib/paths.mjs';
import { findLeaks, knownSecrets, knownSeeds } from './lib/secrets.mjs';
import { wrangler } from './lib/wrangler.mjs';

export const BUDGET = {
  initialJsGz: 170 * 1024,
  initialCssGz: 32 * 1024,
  chainCoreGz: 160 * 1024,
  pumpSdkGz: 450 * 1024,
};

export const DEV_MARKERS = ['cs-devnet-test-wallet-v1', 'Devnet Test Wallet', '/api/dev/', 'devCode', '__csTestWallet', 'installDevTools'];
// '482913' = the Phase-1 demo claim code: only the demo Worker may contain it (worker/api.ts compile-time guard)
export const WORKER_DEV_MARKERS = ['/api/dev/', 'screenVerifier', 'DEV_FAUCET', '482913'];
export const FORBIDDEN_URLS = ['g.alchemy.com', 'helius-rpc.com'];
export const SERVER_SECRET_NAMES = ['ALCHEMY_API_KEY', 'GOOGLE_SERVER_KEY', 'ATTESTOR_SECRET', 'CRANK_SECRET', 'HMAC_KEY', 'DEV_FAUCET_SECRET', 'TWILIO_AUTH_TOKEN', 'TURNSTILE_SECRET_KEY'];
/** The legal pages a mainnet build must ship (public/ → dist/), served as /terms and /privacy. */
export const LEGAL_PAGES = ['terms.html', 'privacy.html'];
/** Prototype / simulated wording that must not survive in the mainnet Terms or Privacy (they cover real money). */
export const PROTOTYPE_WORDING = [/\bprototype\b/i, /\bsimulat\w*/i, /\bno real (?:money|transactions?)\b/i, /\bnever (?:be )?asked to sign\b/i, /\bnever ask you to sign\b/i, /\bfictional\b/i];

/** Prototype phrases found in a legal page (tags and comments stripped first); [] = fine for real money. */
export function legalPageProblems(html) {
  const text = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  return PROTOTYPE_WORDING.map((re) => re.exec(text)?.[0]).filter(Boolean);
}

/** Chunk fingerprints (strings that survive minification). */
export const FINGERPRINTS = {
  pumpSdk: ['buy_exact_quote_in_v3', 'bonding_curve'],
  pumpSwap: ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'collect_coin_creator_fee'],
  web3: ['VersionedMessage.deserialize'],
  shopVault: ['CORNERSHOP:LNCH1'],
  testWallet: ['cs-devnet-test-wallet-v1'],
};

const isRelJs = (s) => /^(\.\.?\/|\/assets\/)[^"'`]+\.m?js$/.test(s);

/** Static import / re-export specifiers of an ES module chunk (relative .js only; `import(...)` excluded). */
export function staticImports(code) {
  const out = new Set();
  for (const m of code.matchAll(/\bfrom\s*["']([^"']+)["']/g)) if (isRelJs(m[1])) out.add(m[1]);
  for (const m of code.matchAll(/\bimport\s*["']([^"']+)["']/g)) if (isRelJs(m[1])) out.add(m[1]);
  return [...out];
}

/** Dynamic import specifiers (`import("./x.js")` or import(`./x.js`)). */
export function dynamicImports(code) {
  const out = new Set();
  for (const m of code.matchAll(/\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) if (isRelJs(m[1])) out.add(m[1]);
  return [...out];
}

/** Entry scripts, modulepreloads and local stylesheets referenced by index.html (paths relative to dist). */
export function htmlRefs(html) {
  const scripts = [];
  const css = [];
  for (const tag of html.match(/<(script|link)\b[^>]*>/gi) ?? []) {
    const src = /\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src || /^(https?:)?\/\//i.test(src)) continue;
    const p = src.replace(/^\//, '');
    if (/^<script/i.test(tag) && /type\s*=\s*["']module["']/i.test(tag)) scripts.push(p);
    else if (/rel\s*=\s*["']modulepreload["']/i.test(tag)) scripts.push(p);
    else if (/rel\s*=\s*["']stylesheet["']/i.test(tag)) css.push(p);
  }
  return { scripts, css };
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/** The initial JS set: entries + transitive static imports. Returns relative paths. */
export function initialJs(dist, entries) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    const abs = join(dist, rel);
    if (!existsSync(abs)) continue;
    seen.add(rel);
    const code = readFileSync(abs, 'utf8');
    for (const spec of staticImports(code)) {
      const next = spec.startsWith('/') ? spec.slice(1) : posix.normalize(posix.join(posix.dirname(rel), spec));
      if (!seen.has(next)) stack.push(next);
    }
  }
  return [...seen];
}

export function classify(code) {
  const has = (list) => list.every((m) => code.includes(m));
  return {
    pumpSdk: has(FINGERPRINTS.pumpSdk),
    pumpSwap: has(FINGERPRINTS.pumpSwap),
    web3: has(FINGERPRINTS.web3),
    shopVault: has(FINGERPRINTS.shopVault),
    testWallet: has(FINGERPRINTS.testWallet),
  };
}

export async function checkBundle({ dist, cluster, worker, buildWorker }) {
  const checks = new Checks();
  const report = { dist: relative(ROOT, dist), cluster, chunks: [], at: new Date().toISOString() };
  if (!existsSync(join(dist, 'index.html'))) {
    checks.fail('index.html', `${relative(ROOT, dist)}/index.html missing (build first)`);
    return { checks, report };
  }
  const files = walk(dist);
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const refs = htmlRefs(html);
  const initial = new Set(initialJs(dist, refs.scripts));

  // ------------------------------------------------------------------------------------------ sizes + chunks
  head(`chunks (${relative(ROOT, dist)})`);
  let initialGz = 0;
  const kinds = { pumpSdk: [], pumpSwap: [], web3: [], testWallet: [] };
  for (const abs of files.filter((f) => /\.m?js$/.test(f))) {
    const rel = relative(dist, abs).split('\\').join('/');
    const buf = readFileSync(abs);
    const code = buf.toString('utf8');
    const size = gz(buf);
    const c = classify(code);
    const row = { file: rel, bytes: buf.length, gzip: size, initial: initial.has(rel), ...c, dynamicImports: dynamicImports(code).length };
    report.chunks.push(row);
    if (initial.has(rel)) initialGz += size;
    for (const k of Object.keys(kinds)) if (c[k]) kinds[k].push(row);
  }
  report.chunks.sort((a, b) => b.gzip - a.gzip);
  for (const r of report.chunks.slice(0, 12)) {
    const tags = ['pumpSdk', 'pumpSwap', 'web3', 'shopVault', 'testWallet'].filter((k) => r[k]);
    info(`${r.initial ? 'INITIAL ' : '        '}${kb(r.gzip).padStart(9)} gz  ${r.file}${tags.length ? `  [${tags.join(', ')}]` : ''}`);
  }
  let cssGz = 0;
  for (const c of refs.css) if (existsSync(join(dist, c))) cssGz += gz(readFileSync(join(dist, c)));
  report.initialJsGz = initialGz;
  report.initialCssGz = cssGz;

  const budgets = cluster === 'devnet' || cluster === 'mainnet';
  head('budgets (INTEGRATION §8)');
  if (budgets) {
    checks.check(initialGz <= BUDGET.initialJsGz, 'initial JS ≤ 170 KB gz', `${kb(initialGz)} over ${initial.size} file(s)`);
    checks.check(cssGz <= BUDGET.initialCssGz, 'initial CSS ≤ 32 KB gz', kb(cssGz));
  } else info(`initial JS ${kb(initialGz)} gz · CSS ${kb(cssGz)} gz (demo build: budgets not enforced)`);

  if (!kinds.pumpSdk.length) checks.warn('pump SDK chunk', 'not present in this build (no launch/trade code bundled yet)');
  for (const r of kinds.pumpSdk) {
    checks.check(!r.initial, 'pump SDK not on the initial path', r.file);
    if (budgets) checks.check(r.gzip <= BUDGET.pumpSdkGz, 'pump SDK chunk ≤ 450 KB gz', `${kb(r.gzip)} ${r.file}`);
    checks.check(!r.web3 || !r.shopVault, 'pump SDK chunk is separate from the chain core', r.file);
  }
  for (const r of kinds.pumpSwap) checks.check(!r.initial, 'pump-swap (AMM) not on the initial path', r.file);
  const core = kinds.web3.filter((r) => !r.pumpSdk);
  if (!core.length && !kinds.web3.length) checks.warn('chain core chunk', 'web3.js not present in this build yet');
  for (const r of core) {
    checks.check(!r.initial, 'chain core (web3.js) not on the initial path', r.file);
    if (budgets) checks.check(r.gzip <= BUDGET.chainCoreGz, 'chain core chunk ≤ 160 KB gz', `${kb(r.gzip)} ${r.file}`);
  }
  for (const r of kinds.testWallet) checks.check(!r.initial, 'devnet test wallet not on the initial path', r.file);
  const maps = files.filter((f) => f.endsWith('.map'));
  if (maps.length) checks.warn('source maps shipped', `${maps.length} .map file(s); they expose source`);
  const headers = join(dist, '_headers');
  if (existsSync(headers) && /\/assets\/\*[\s\S]*immutable/.test(readFileSync(headers, 'utf8'))) checks.pass('_headers', '/assets/* immutable');
  else checks.warn('_headers', 'no `/assets/*  Cache-Control: public, max-age=31536000, immutable` (public/_headers, integrator)');

  // ------------------------------------------------------------------------------------------ leaks
  head('leak scan (values compared in memory; names only reported)');
  const secrets = knownSecrets();
  const seeds = knownSeeds();
  let leakFiles = 0;
  for (const abs of files) {
    const buf = readFileSync(abs);
    const rel = relative(dist, abs);
    const hits = findLeaks(buf, secrets, seeds);
    if (hits.length) {
      leakFiles++;
      checks.fail(`secret value in ${rel}`, hits.join(', '));
    }
    const text = buf.toString('latin1');
    for (const u of FORBIDDEN_URLS) if (text.includes(u)) checks.fail(`provider URL in ${rel}`, u);
    if (/\.(m?js|html)$/.test(rel)) for (const n of SERVER_SECRET_NAMES) if (text.includes(n)) checks.fail(`server secret name in ${rel}`, `${n} (server code bundled into the client?)`);
  }
  if (!leakFiles) checks.pass('no secret value in any client file', `${files.length} files · ${secrets.length} secret encodings · ${seeds.length} raw seeds`);

  // ------------------------------------------------------------------------------------------ H6 proofs
  head(`devnet-only code (${cluster})`);
  const markerHits = [];
  for (const abs of files.filter((f) => /\.(m?js|html|css|json|txt)$/.test(f))) {
    const text = readFileSync(abs, 'utf8');
    for (const m of DEV_MARKERS) if (text.includes(m)) markerHits.push(`${relative(dist, abs)}: ${m}`);
  }
  if (cluster === 'mainnet') {
    if (markerHits.length) for (const h of markerHits) checks.fail('devnet-only marker in the mainnet bundle', h);
    else checks.pass('mainnet bundle has no devnet-only markers', DEV_MARKERS.join(' · '));
  } else info(markerHits.length ? `devnet-only code present (expected on devnet): ${markerHits.length} hit(s)` : 'no devnet-only markers');

  if (cluster === 'mainnet') {
    head('legal pages (real money)');
    for (const page of LEGAL_PAGES) {
      const p = join(dist, page);
      if (!existsSync(p)) {
        checks.fail(`${page} missing`, 'the mainnet build must ship Terms and Privacy (public/)');
        continue;
      }
      const found = legalPageProblems(readFileSync(p, 'utf8'));
      if (found.length) checks.fail(`prototype wording in ${page}`, found.join(' · '));
      else checks.pass(`${page} has no prototype wording`, 'written for real money');
    }
  }

  if (buildWorker) {
    const out = join(ROOT, '.wrangler', `check-${cluster}`);
    const r = await wrangler(['deploy', '--dry-run', '--env', cluster, '--outdir', out], { timeoutMs: 300_000 });
    checks.check(r.code === 0, `worker dry-run bundle (--env ${cluster})`, r.code === 0 ? relative(ROOT, out) : (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' '));
    worker = out;
  }
  if (worker) {
    if (!existsSync(worker)) checks.fail('worker bundle', `${worker} missing (wrangler deploy --dry-run --env ${cluster} --outdir ${worker})`);
    else {
      const wfiles = walk(worker).filter((f) => /\.(m?js|cjs)$/.test(f));
      let hit = false;
      for (const abs of wfiles) {
        const text = readFileSync(abs, 'utf8');
        if (cluster === 'mainnet') {
          for (const m of WORKER_DEV_MARKERS) if (text.includes(m)) {
            hit = true;
            checks.fail('devnet-only code in the mainnet Worker bundle', `${basename(abs)}: ${m}`);
          }
        }
        const leaks = findLeaks(Buffer.from(text), secrets, seeds);
        if (leaks.length) checks.fail(`secret value in the Worker bundle ${basename(abs)}`, leaks.join(', '));
      }
      if (cluster === 'mainnet' && !hit) checks.pass('mainnet Worker bundle has no /api/dev/, screenVerifier, DEV_FAUCET, demo claim code', `${wfiles.length} file(s)`);
    }
  }
  report.checks = checks.toJSON();
  return { checks, report };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['json', 'build-worker']);
  const distArg = args._[0];
  const cluster = args.cluster;
  if (!distArg || !['devnet', 'mainnet', 'demo'].includes(cluster)) {
    console.error('usage: node scripts/check-bundle.mjs <dist-dir> --cluster devnet|mainnet|demo [--worker <dir>] [--build-worker] [--json]');
    process.exit(64);
  }
  const dist = resolve(ROOT, distArg);
  if (cluster === 'mainnet' && /dist-devnet/.test(dist)) fatal('refusing: a devnet build checked as mainnet');
  head(`check-bundle · ${relative(ROOT, dist)} · ${cluster}`);
  const { checks, report } = await checkBundle({ dist, cluster, worker: args.worker ? resolve(ROOT, String(args.worker)) : undefined, buildWorker: !!args['build-worker'] });
  const green = checks.summary('check-bundle');
  if (args.json) {
    mkdirSync(OUT_DIR, { recursive: true });
    const p = join(OUT_DIR, `check-bundle-${cluster}.json`);
    writeFileSync(p, JSON.stringify(report, null, 2));
    info(`report: ${relative(ROOT, p)}`);
  }
  process.exit(green ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fatal(e.message));
}
