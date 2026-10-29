/**
 * wrangler helpers: run the CLI with redacted output, read wrangler.jsonc (BACKEND owns it; OPS may only replace the
 * exact `__D1_DEVNET_ID__` / `__D1_MAINNET_ID__` tokens once, INTEGRATION §1.4), D1 and secret listings.
 * Every wrangler call runs from the repo root with stdin closed unless a value is piped in.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { redact } from './log.mjs';
import { D1_NAMES, D1_PLACEHOLDERS, ROOT, toolEnv, WORKER_NAMES, WRANGLER_CONFIG } from './paths.mjs';

/** Strip // and /* *\/ comments and trailing commas from JSONC, respecting strings. */
export function stripJsonc(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // trailing commas (outside strings: strings no longer contain unescaped structure we care about here)
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}

export function readWranglerConfig(path = WRANGLER_CONFIG) {
  return parseJsonc(readFileSync(path, 'utf8'));
}

/** The effective env block (or null when wrangler.jsonc has no env.<env>). */
export function envConfig(env, cfg = readWranglerConfig()) {
  return cfg.env?.[env] ?? null;
}

/**
 * Checks that wrangler.jsonc has env.<env> named exactly as INTEGRATION §1.4 requires.
 * @returns {string[]} problems (empty = ok)
 */
export function envProblems(env, cfg = readWranglerConfig()) {
  const e = envConfig(env, cfg);
  if (!e) return [`wrangler.jsonc has no env.${env} (BACKEND adds it, INTEGRATION §1.4)`];
  const p = [];
  if (e.name !== WORKER_NAMES[env]) p.push(`env.${env}.name is ${JSON.stringify(e.name)}, expected ${JSON.stringify(WORKER_NAMES[env])}`);
  if (e.vars?.CLUSTER !== env) p.push(`env.${env}.vars.CLUSTER is ${JSON.stringify(e.vars?.CLUSTER)}, expected "${env}"`);
  const db = (e.d1_databases ?? []).find((d) => d.binding === 'DB');
  if (!db) p.push(`env.${env} has no D1 binding DB`);
  else if (db.database_name !== D1_NAMES[env]) p.push(`env.${env} D1 database_name is ${JSON.stringify(db.database_name)}, expected ${D1_NAMES[env]}`);
  const dev = e.define?.__CS_DEV_ENDPOINTS__;
  if (env === 'mainnet' && dev !== 'false') p.push(`env.mainnet.define.__CS_DEV_ENDPOINTS__ must be "false" (H6), got ${JSON.stringify(dev)}`);
  if (env === 'devnet' && dev !== 'true') p.push(`env.devnet.define.__CS_DEV_ENDPOINTS__ should be "true", got ${JSON.stringify(dev)}`);
  if (e.define?.__CS_CLUSTER__ !== JSON.stringify(env)) p.push(`env.${env}.define.__CS_CLUSTER__ should be '"${env}"'`);
  if (env === 'mainnet' && e.vars && 'DEV_FAUCET_SECRET' in e.vars) p.push('env.mainnet.vars must not mention DEV_FAUCET_SECRET');
  if (env === 'mainnet' && /dist-devnet/.test(e.assets?.directory ?? '')) p.push('env.mainnet.assets.directory points at a devnet build');
  return p;
}

/** The D1 database_id configured for env (may still be the placeholder token). */
export function configuredD1Id(env, cfg = readWranglerConfig()) {
  return (envConfig(env, cfg)?.d1_databases ?? []).find((d) => d.binding === 'DB')?.database_id ?? null;
}

/**
 * Replace the exact placeholder token for env with `uuid`, once. Refuses when the token is absent, appears more than
 * once, or the file would then disagree with what we parsed. Returns true when the file changed.
 */
export function replaceD1Placeholder(env, uuid, path = WRANGLER_CONFIG) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) throw new Error('D1 id is not a uuid');
  const token = D1_PLACEHOLDERS[env];
  const text = readFileSync(path, 'utf8');
  const count = text.split(token).length - 1;
  if (count === 0) return false;
  if (count > 1) throw new Error(`${token} appears ${count} times in wrangler.jsonc; refusing to edit`);
  const next = text.replace(`"${token}"`, `"${uuid}"`);
  if (next === text) throw new Error(`${token} is not a whole JSON string value in wrangler.jsonc; refusing to edit`);
  const parsed = parseJsonc(next);
  if (configuredD1Id(env, parsed) !== uuid) throw new Error(`after replacing ${token}, env.${env} DB id does not match; refusing`);
  writeFileSync(path, next);
  return true;
}

/**
 * Run `npx wrangler …` from the repo root. Output is captured and redacted; `stdin` (string) is piped when given.
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function wrangler(args, opts) {
  return spawnWrangler(args, opts).then((r) => ({ code: r.code, stdout: redact(r.stdout), stderr: redact(r.stderr) }));
}

/** The raw run behind `wrangler()` (echo is still redacted). Only for output that is parsed here and never shown. */
function spawnWrangler(args, { stdin, echo = false, timeoutMs = 600_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['--no-install', 'wrangler', ...args], {
      cwd: ROOT,
      env: toolEnv({ WRANGLER_SEND_METRICS: 'false', CI: '1', FORCE_COLOR: '0', ...env }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
      if (echo) process.stdout.write(redact(String(d)));
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (echo) process.stderr.write(redact(String(d)));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

/**
 * The Cloudflare account the AtlasPad Workers and D1 databases live in. An account id is not a secret (it is in every
 * dashboard URL) and names nobody, unlike the account NAME of a personal login (its email). A fork that deploys to its
 * own account sets CS_CLOUDFLARE_ACCOUNT_ID instead of editing this.
 */
export const ATLASPAD_CLOUDFLARE_ACCOUNT_ID = '240598b2d2efe55e0828c6c0557cd0a0';
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
/** What a failed account check tells the operator to do. */
export const WRANGLER_LOGIN_FIX = 'npx wrangler login (a fork deploying to its own account: set CS_CLOUDFLARE_ACCOUNT_ID)';

/** The account deploys must run against: CS_CLOUDFLARE_ACCOUNT_ID when set, else AtlasPad's. Throws on a malformed id. */
export function expectedAccountId(env = process.env) {
  const v = String(env.CS_CLOUDFLARE_ACCOUNT_ID ?? '').trim().toLowerCase();
  if (!v) return ATLASPAD_CLOUDFLARE_ACCOUNT_ID;
  if (!ACCOUNT_ID.test(v)) throw new Error('CS_CLOUDFLARE_ACCOUNT_ID must be a 32-character hex Cloudflare account id (dash.cloudflare.com → Workers & Pages → Account ID)');
  return v;
}

/**
 * The account ids in `wrangler whoami --json` output (`accounts[].id`); for plain-text output, the ids in its account
 * table. Account names and the login email are never read.
 */
export function whoamiAccountIds(stdout) {
  const text = String(stdout ?? '');
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      const j = JSON.parse(text.slice(start));
      if (Array.isArray(j.accounts)) return j.accounts.map((a) => String(a?.id ?? '').toLowerCase()).filter((id) => ACCOUNT_ID.test(id));
    } catch {
      /* not JSON: read the table below */
    }
  }
  const ids = text
    .split('\n')
    .filter((l) => /[│|]/.test(l))
    .flatMap((l) => [...l.matchAll(/(?:^|[│|\s])([0-9a-f]{32})(?=[│|\s]|$)/gi)].map((m) => m[1].toLowerCase()));
  return [...new Set(ids)];
}

/**
 * True when wrangler is logged in with access to the expected Cloudflare account (by id). The output is parsed raw,
 * never shown: redact() would hide the id if any .env.server value happened to equal it.
 */
export async function whoamiMatches(expect = expectedAccountId()) {
  const r = await spawnWrangler(['whoami', '--json']);
  return r.code === 0 && whoamiAccountIds(r.stdout).includes(String(expect).toLowerCase());
}

/** @returns {Promise<{uuid:string,name:string}[]>} */
export async function d1List() {
  const r = await wrangler(['d1', 'list', '--json']);
  if (r.code !== 0) throw new Error(`wrangler d1 list failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  const start = r.stdout.indexOf('[');
  return JSON.parse(r.stdout.slice(start));
}

/** Secret NAMES set on the env's Worker; null when the Worker does not exist yet. */
export async function secretNames(env) {
  const r = await wrangler(['secret', 'list', '--env', env, '--format', 'json']);
  if (r.code !== 0) {
    if (/not found|does not exist|10007|could not find/i.test(r.stderr + r.stdout)) return null;
    throw new Error(`wrangler secret list --env ${env} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
  }
  const start = r.stdout.indexOf('[');
  if (start < 0) return [];
  return JSON.parse(r.stdout.slice(start)).map((s) => s.name);
}

/** Pending (unapplied) remote migrations for the env's DB, or null when the DB is not reachable/configured. */
export async function pendingMigrations(env) {
  const r = await wrangler(['d1', 'migrations', 'list', D1_NAMES[env], '--env', env, '--remote']);
  const text = r.stdout + r.stderr;
  if (r.code !== 0) return { ok: false, error: text.trim().split('\n').slice(-3).join(' ') };
  if (/No migrations to apply/i.test(text)) return { ok: true, pending: [] };
  const pending = [...text.matchAll(/(\d{4}_[\w-]+\.sql)/g)].map((m) => m[1]);
  return { ok: true, pending: [...new Set(pending)] };
}

/**
 * `wrangler d1 execute <db> --env <env> --remote --json --command <sql>`. The SQL must already be safe: callers only
 * interpolate values they validated against a strict charset (base58, hex, integers) and quote nothing else.
 * Returns the rows of the last statement.
 */
export async function d1Execute(env, sql, { remote = true } = {}) {
  if (!D1_NAMES[env]) throw new Error(`env must be devnet or mainnet (got ${env})`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(sql)) throw new Error('control characters in SQL');
  const args = ['d1', 'execute', D1_NAMES[env], '--env', env, remote ? '--remote' : '--local', '--json', '--command', sql];
  const r = await wrangler(args);
  if (r.code !== 0) throw new Error(`wrangler d1 execute failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
  const start = r.stdout.indexOf('[');
  const parsed = JSON.parse(r.stdout.slice(start));
  const last = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
  return last?.results ?? [];
}

/** The D1 uuid for env's database name, or null. */
export async function d1Uuid(env) {
  const list = await d1List();
  return list.find((d) => d.name === D1_NAMES[env])?.uuid ?? null;
}

/** Creates env's D1 database when missing (idempotent). Returns { uuid, created }. */
export async function d1Ensure(env) {
  const have = await d1Uuid(env);
  if (have) return { uuid: have, created: false };
  const r = await wrangler(['d1', 'create', D1_NAMES[env]]);
  if (r.code !== 0) throw new Error(`wrangler d1 create ${D1_NAMES[env]} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
  const uuid = await d1Uuid(env);
  if (!uuid) throw new Error(`created ${D1_NAMES[env]} but it is not listed yet; re-run`);
  return { uuid, created: true };
}

/** Applies pending migrations to env's remote D1. Returns the redacted output tail. */
export async function d1MigrateRemote(env) {
  const r = await wrangler(['d1', 'migrations', 'apply', D1_NAMES[env], '--env', env, '--remote'], { timeoutMs: 300_000 });
  if (r.code !== 0) throw new Error(`d1 migrations apply failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-4).join(' ')}`);
  return (r.stdout + r.stderr).trim().split('\n').slice(-3).join(' ');
}

/** Recent deployments of env's Worker (`wrangler deployments list --json`), or null when unavailable. */
export async function deploymentsList(env) {
  const r = await wrangler(['deployments', 'list', '--env', env, '--json']);
  if (r.code !== 0) return null;
  try {
    const start = r.stdout.search(/[[{]/);
    return JSON.parse(r.stdout.slice(start));
  } catch {
    return null;
  }
}
