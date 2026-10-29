/**
 * Console helpers with a redaction guard. Every line that may contain third-party output (CLI, HTTP errors) goes
 * through `redact()`, which removes every known secret value (in memory compare, lib/secrets.mjs), any path segment
 * after `g.alchemy.com/v2/`, any `api-key=` query value, Basic/Bearer credentials, and drops lines that mention seed
 * phrases (as devnet-deploy.sh does).
 */
import { knownSecrets } from './secrets.mjs';

let secretsCache;
function secrets() {
  if (!secretsCache) {
    try {
      secretsCache = knownSecrets().filter((s) => s.value.length >= 8).sort((a, b) => b.value.length - a.value.length);
    } catch {
      secretsCache = [];
    }
  }
  return secretsCache;
}

const SEED_LINE = /seed phrase|recovery phrase|bip39|to recover|recover the intermediate|keygen recover/i;

export function redact(text) {
  if (text === undefined || text === null) return '';
  let s = String(text);
  for (const { value } of secrets()) if (s.includes(value)) s = s.split(value).join('[redacted]');
  s = s
    .replace(/(api[-_]?key=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/(Authorization:\s*(?:Basic|Bearer)\s+)[A-Za-z0-9+/=._-]+/gi, '$1[redacted]')
    .replace(/(g\.alchemy\.com\/v2\/)[^\s"'<>/?#]+/gi, '$1[redacted]')
    .replace(/(helius-rpc\.com\/\?)[^\s"'<>]+/gi, '$1[redacted]');
  return s
    .split('\n')
    .filter((l) => !SEED_LINE.test(l))
    .join('\n');
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const OK = c('32', '✓');
export const BAD = c('31', '✗');
export const WARN = c('33', '!');
export const DOT = c('2', '·');

export function ok(msg) {
  console.log(`${OK} ${redact(msg)}`);
}
export function bad(msg) {
  console.log(`${BAD} ${redact(msg)}`);
}
export function warn(msg) {
  console.log(`${WARN} ${redact(msg)}`);
}
export function info(msg) {
  console.log(`${DOT} ${redact(msg)}`);
}
export function head(msg) {
  console.log(`\n${c('1', redact(msg))}`);
}
export function fatal(msg, code = 1) {
  console.error(`${BAD} ${redact(msg)}`);
  process.exit(code);
}

/** Tracks ✓/✗/! results for a run; `summary()` prints counts and returns true when nothing failed. */
export class Checks {
  constructor() {
    this.items = [];
  }
  pass(what, detail) {
    this.items.push({ status: 'ok', what, detail });
    ok(detail ? `${what} — ${detail}` : what);
  }
  fail(what, detail, todo) {
    this.items.push({ status: 'fail', what, detail, todo });
    bad(detail ? `${what} — ${detail}` : what);
  }
  warn(what, detail) {
    this.items.push({ status: 'warn', what, detail });
    warn(detail ? `${what} — ${detail}` : what);
  }
  check(cond, what, detail, todo) {
    if (cond) this.pass(what, detail);
    else this.fail(what, detail, todo);
    return !!cond;
  }
  get failed() {
    return this.items.filter((i) => i.status === 'fail');
  }
  get warnings() {
    return this.items.filter((i) => i.status === 'warn');
  }
  summary(label = 'checks') {
    const f = this.failed.length;
    const w = this.warnings.length;
    const p = this.items.length - f - w;
    console.log(`\n${f ? BAD : OK} ${label}: ${p} passed, ${f} failed, ${w} warnings`);
    return f === 0;
  }
  toJSON() {
    return this.items.map((i) => ({ ...i, what: redact(i.what), detail: i.detail === undefined ? undefined : redact(i.detail) }));
  }
}

/**
 * Minimal argv parser: --flag, --key value, --key=value, positionals. Names in `booleans` never consume the next
 * token (so `--execute <positional>` keeps the positional).
 */
export function parseArgs(argv = process.argv.slice(2), booleans = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
    // on/off flags take no value: `--execute=false` must never read as "execute" (a non-empty string is truthy), and a
    // bare `--execute` never swallows the next word. `execute` is on/off in every script, declared or not.
    const onOff = booleans.includes(k) || k === 'execute';
    if (eq > 0 && onOff) throw new Error(`--${k} is an on/off flag: pass it bare, without a value`);
    if (eq > 0) out[k] = a.slice(eq + 1);
    else if (onOff) out[k] = true;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fmtSol(lamports) {
  const n = BigInt(lamports);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const whole = a / 1_000_000_000n;
  const frac = (a % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''} SOL`;
}
