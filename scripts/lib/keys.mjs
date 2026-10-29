/**
 * Keypair files in `.keys/` (gitignored, mode 600). Solana CLI format: a JSON array of 64 bytes = seed(32) ‖ pubkey(32).
 *
 * - pubkey(path)      the public key (base58), after checking that the seed really derives it.
 * - secretB64(path)   base64 of the 64 bytes: ONLY for piping into `wrangler secret put` (INTEGRATION §1.6 format).
 * - ensureKey(path)   creates a new keypair file if missing (Node crypto Ed25519, written with O_EXCL and mode 600;
 *                     no seed phrase exists, so nothing can be printed). Same file format as
 *                     `solana-keygen new --no-bip39-passphrase --silent`.
 * - ensureRandomKey   random bytes stored as one base64 line (HMAC_KEY).
 * Nothing in this module prints or returns secret material except secretB64/readSecretKey/readRandomKey, whose
 * callers must only pipe the value.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { b58encode } from './b58.mjs';
import { KEYS_DIR } from './paths.mjs';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function keyPath(nameOrPath) {
  if (isAbsolute(nameOrPath) || nameOrPath.includes('/')) return nameOrPath;
  return join(KEYS_DIR, nameOrPath.endsWith('.json') || nameOrPath.endsWith('.key') ? nameOrPath : `${nameOrPath}.json`);
}

/** Ed25519 public key (32 bytes) derived from a 32-byte seed with Node's WebCrypto-compatible implementation. */
export function pubkeyFromSeed(seed) {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  return Uint8Array.from(spki.subarray(spki.length - 32));
}

/** The 64 secret-key bytes. Throws (without echoing content) when the file is malformed or inconsistent. */
export function readSecretKey(nameOrPath) {
  const p = keyPath(nameOrPath);
  if (!existsSync(p)) throw new Error(`missing key file ${p}`);
  let arr;
  try {
    arr = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    throw new Error(`key file ${basename(p)} is not valid JSON`);
  }
  if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) {
    throw new Error(`key file ${basename(p)} is not a 64-byte Solana keypair`);
  }
  const bytes = Uint8Array.from(arr);
  const derived = pubkeyFromSeed(bytes.subarray(0, 32));
  if (!derived.every((b, i) => b === bytes[32 + i])) throw new Error(`key file ${basename(p)}: seed does not derive its public key`);
  return bytes;
}

export function pubkey(nameOrPath) {
  return b58encode(readSecretKey(nameOrPath).subarray(32));
}

/** base64(seed ‖ pubkey): the Worker secret format for ATTESTOR_SECRET / CRANK_SECRET / DEV_FAUCET_SECRET. */
export function secretB64(nameOrPath) {
  return Buffer.from(readSecretKey(nameOrPath)).toString('base64');
}

/** Warn-level problem string when a key file is readable by group/others, else null. */
export function permissionProblem(nameOrPath) {
  const p = keyPath(nameOrPath);
  try {
    const mode = statSync(p).mode & 0o777;
    return mode & 0o077 ? `${basename(p)} has mode ${mode.toString(8)} (expected 600)` : null;
  } catch {
    return null;
  }
}

function writeExclusive(p, text) {
  const fd = openSync(p, 'wx', 0o600); // O_CREAT|O_EXCL: never overwrites an existing key
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  chmodSync(p, 0o600);
}

/** Creates the keypair file when missing. Returns { path, pubkey, created }. */
export function ensureKey(nameOrPath) {
  const p = keyPath(nameOrPath);
  if (existsSync(p)) return { path: p, pubkey: pubkey(p), created: false };
  const { privateKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  const seed = der.subarray(der.length - 32);
  const pub = pubkeyFromSeed(seed);
  writeExclusive(p, JSON.stringify([...seed, ...pub]));
  return { path: p, pubkey: b58encode(pub), created: true };
}

/** Random secret (default 32 bytes) stored as a base64 line, e.g. `.keys/devnet-hmac.key`. */
export function ensureRandomKey(nameOrPath, bytes = 32) {
  const p = keyPath(nameOrPath);
  if (existsSync(p)) return { path: p, created: false };
  writeExclusive(p, `${randomBytes(bytes).toString('base64')}\n`);
  return { path: p, created: true };
}

/** The base64 value of a random-key file (HMAC_KEY). Only for piping. */
export function readRandomKey(nameOrPath) {
  const p = keyPath(nameOrPath);
  if (!existsSync(p)) throw new Error(`missing key file ${p}`);
  const v = readFileSync(p, 'utf8').trim();
  if (!/^[A-Za-z0-9+/]{40,}={0,2}$/.test(v)) throw new Error(`${basename(p)} is not a base64 key`);
  return v;
}

/** A web3.js Keypair for signing inside a script (web3 loaded lazily from the shop-vault client). */
export async function keypair(nameOrPath) {
  const { web3 } = await import('./web3.mjs');
  return web3.Keypair.fromSecretKey(readSecretKey(nameOrPath));
}
