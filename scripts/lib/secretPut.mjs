#!/usr/bin/env node
/**
 * Pipe ONE secret into `npx wrangler secret put NAME --env ENV` through stdin (INTEGRATION §1.6, H2).
 * The value is read in-process and never printed, logged or passed as an argument.
 *
 *   node scripts/lib/secretPut.mjs NAME --env devnet|mainnet --from <source> [--execute]
 *     sources: env:<NAME in .env.server> · key:<.keys file (64-byte keypair → base64)> · b64file:<.keys/*.key>
 *   Without --execute it only checks that the source exists (dry run).
 *
 * Library: putSecret(name, value, env) / secretSources(env) / resolveSource(spec).
 */
import { basename } from 'node:path';
import { alchemySourceName, envValue } from './env.mjs';
import { readRandomKey, secretB64 } from './keys.mjs';
import { bad, ok, parseArgs } from './log.mjs';
import { wrangler } from './wrangler.mjs';

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Secrets that must never exist on mainnet (H6). */
export const DEVNET_ONLY_SECRETS = ['DEV_FAUCET_SECRET'];

/**
 * The secret set per env (INTEGRATION §1.6) → source spec. `required: false` = set only when the source exists.
 * @returns {{name:string, source:string, required:boolean}[]}
 */
export function secretSources(env) {
  const common = (k) => [
    { name: 'ALCHEMY_API_KEY', source: `env:${alchemySourceName(k)}`, required: true },
    { name: 'GOOGLE_SERVER_KEY', source: 'env:GOOGLE_SERVER_KEY', required: true },
    { name: 'ATTESTOR_SECRET', source: `key:${k}-attestor.json`, required: true },
    { name: 'CRANK_SECRET', source: `key:${k}-crank.json`, required: true },
    { name: 'HMAC_KEY', source: `b64file:${k}-hmac.key`, required: true },
  ];
  if (env === 'devnet') {
    return [
      ...common('devnet'),
      { name: 'DEV_FAUCET_SECRET', source: 'key:devnet-faucet.json', required: true },
      { name: 'TWILIO_ACCOUNT_SID', source: 'env:TWILIO_ACCOUNT_SID', required: false },
      { name: 'TWILIO_AUTH_TOKEN', source: 'env:TWILIO_AUTH_TOKEN', required: false },
      { name: 'TWILIO_VERIFY_SID', source: 'env:TWILIO_VERIFY_SID', required: false },
      { name: 'TURNSTILE_SECRET_KEY', source: 'env:TURNSTILE_SECRET_KEY', required: false },
      { name: 'ALERT_WEBHOOK_URL', source: 'env:ALERT_WEBHOOK_URL', required: false },
      { name: 'ALERT_EMAIL_TO', source: 'env:ALERT_EMAIL_TO', required: false },
    ];
  }
  if (env === 'mainnet') {
    return [
      ...common('mainnet'),
      // phone verification is optional on mainnet: without all three, owners verify with a website code
      { name: 'TWILIO_ACCOUNT_SID', source: 'env:TWILIO_ACCOUNT_SID', required: false },
      { name: 'TWILIO_AUTH_TOKEN', source: 'env:TWILIO_AUTH_TOKEN', required: false },
      { name: 'TWILIO_VERIFY_SID', source: 'env:TWILIO_VERIFY_SID', required: false },
      // only the phone 'call me' step uses Turnstile: optional while phone checks are off (go-mainnet requires it with Twilio)
      { name: 'TURNSTILE_SECRET_KEY', source: 'env:TURNSTILE_SECRET_KEY', required: false },
      // owner alerts: a Discord/Slack webhook and/or the free email (Cloudflare Email Routing to a verified address);
      // go-mainnet requires at least one of the two
      { name: 'ALERT_WEBHOOK_URL', source: 'env:ALERT_WEBHOOK_URL', required: false },
      { name: 'ALERT_EMAIL_TO', source: 'env:ALERT_EMAIL_TO', required: false },
      { name: 'JUPITER_API_KEY', source: 'env:JUPITER_API_KEY', required: false },
    ];
  }
  throw new Error(`env must be devnet or mainnet (got ${env})`);
}

/** Resolve a source spec to its value (in memory). Returns undefined when the source is missing. */
export function resolveSource(spec) {
  const [kind, ...rest] = spec.split(':');
  const arg = rest.join(':');
  try {
    if (kind === 'env') return envValue(arg);
    if (kind === 'key') return secretB64(arg);
    if (kind === 'b64file') return readRandomKey(arg);
  } catch {
    return undefined;
  }
  throw new Error(`unknown secret source kind ${kind}`);
}

/** Human description of a source without its value. */
export function describeSource(spec) {
  const [kind, ...rest] = spec.split(':');
  const arg = rest.join(':');
  if (kind === 'env') return `.env.server ${arg}`;
  return `.keys/${basename(arg)}`;
}

/** Pipe one value into wrangler. Never prints the value. */
export async function putSecret(name, value, env) {
  if (!NAME_RE.test(name)) throw new Error(`bad secret name ${name}`);
  if (env !== 'devnet' && env !== 'mainnet') throw new Error(`env must be devnet or mainnet (got ${env})`);
  if (env === 'mainnet' && DEVNET_ONLY_SECRETS.includes(name)) throw new Error(`${name} must never exist on mainnet (H6)`);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name}: empty value`);
  if (/[\r\n]/.test(value)) throw new Error(`${name}: value contains a newline`);
  const r = await wrangler(['secret', 'put', name, '--env', env], { stdin: value });
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout).trim().split('\n').slice(-4).join(' | ');
    throw new Error(`wrangler secret put ${name} --env ${env} failed: ${tail}`);
  }
  return true;
}

/**
 * Pipe several secrets in ONE `wrangler secret bulk --env ENV` call: the JSON object goes through stdin only (no
 * temp file, no argv). Validates every name/value first; never prints a value. Returns the list of names set.
 * @param {Record<string,string>} map
 */
export async function putSecretsBulk(map, env) {
  if (env !== 'devnet' && env !== 'mainnet') throw new Error(`env must be devnet or mainnet (got ${env})`);
  const names = Object.keys(map);
  if (!names.length) return [];
  for (const name of names) {
    const value = map[name];
    if (!NAME_RE.test(name)) throw new Error(`bad secret name ${name}`);
    if (env === 'mainnet' && DEVNET_ONLY_SECRETS.includes(name)) throw new Error(`${name} must never exist on mainnet (H6)`);
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${name}: empty value`);
    if (/[\r\n]/.test(value)) throw new Error(`${name}: value contains a newline`);
  }
  const r = await wrangler(['secret', 'bulk', '--env', env], { stdin: JSON.stringify(map) });
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout).trim().split('\n').slice(-4).join(' | ');
    throw new Error(`wrangler secret bulk --env ${env} failed: ${tail}`);
  }
  return names;
}

/**
 * Resolve the §1.6 secret set for `env` in memory. Returns { values: {NAME: value}, missingRequired: [names],
 * missingOptional: [names], sources: [{name, source, required, present}] } (sources/names only are printable).
 */
export function collectSecrets(env) {
  const values = {};
  const missingRequired = [];
  const missingOptional = [];
  const sources = [];
  for (const s of secretSources(env)) {
    const v = resolveSource(s.source);
    sources.push({ name: s.name, source: describeSource(s.source), required: s.required, present: !!v });
    if (v) values[s.name] = v;
    else if (s.required) missingRequired.push(s.name);
    else missingOptional.push(s.name);
  }
  return { values, missingRequired, missingOptional, sources };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['execute']);
  const [name] = args._;
  const env = args.env;
  if (!name || !env || !args.from) {
    console.error('usage: node scripts/lib/secretPut.mjs NAME --env devnet|mainnet --from env:X|key:file.json|b64file:file.key [--execute]');
    process.exit(64);
  }
  const value = resolveSource(String(args.from));
  if (!value) {
    bad(`${name}: source ${describeSource(String(args.from))} is missing or empty`);
    process.exit(1);
  }
  if (!args.execute) {
    ok(`${name}: source ${describeSource(String(args.from))} present (dry run; add --execute to set it on --env ${env})`);
    return;
  }
  await putSecret(name, value, env);
  ok(`${name} set on --env ${env} (from ${describeSource(String(args.from))})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    bad(e.message);
    process.exit(1);
  });
}
