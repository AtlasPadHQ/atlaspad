/**
 * deploy/<cluster>.json: the single source of truth for on-chain addresses (INTEGRATION §1.2). PUBLIC DATA ONLY.
 * writeDeploy() refuses any value that is not a plain address/number/boolean/short string, and any key that is not
 * in the schema, so a secret can never land in this committed file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAddress } from './b58.mjs';
import { assertCluster, DEPLOY_DIR } from './paths.mjs';

const ADDRESS_FIELDS = ['programId', 'configPda', 'alt', 'altPending', 'attestor', 'guardian', 'governance', 'upgradeAuthority', 'crank', 'faucet', 'squadsA', 'squadsAVault', 'squadsB', 'squadsBVault', 'deployer'];
const STRING_FIELDS = ['cluster', 'genesisHash', 'programDataSha256', 'updatedAt', 'programDeployedAt', 'configInitializedAt', 'configInitSignature', 'altCreatedAt', 'note', 'flavor'];
const NUMBER_FIELDS = ['claimWindowSecs', 'rotationDelaySecs', 'programSoBytes', 'squadsATimeLockSecs', 'squadsBTimeLockSecs'];
const ARRAY_FIELDS = ['altKeys'];
const ALLOWED = new Set([...ADDRESS_FIELDS, ...STRING_FIELDS, ...NUMBER_FIELDS, ...ARRAY_FIELDS]);

export function deployPath(cluster) {
  return join(DEPLOY_DIR, `${assertCluster(cluster)}.json`);
}

export function readDeploy(cluster) {
  const p = deployPath(cluster);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function validate(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (!ALLOWED.has(k)) throw new Error(`deploy json: unknown field ${k} (public schema only)`);
    if (v === null) continue;
    if (ADDRESS_FIELDS.includes(k) && !isAddress(v)) throw new Error(`deploy json: ${k} is not a base58 address`);
    if (STRING_FIELDS.includes(k) && (typeof v !== 'string' || v.length > 200)) throw new Error(`deploy json: ${k} must be a short string`);
    if (NUMBER_FIELDS.includes(k) && !Number.isSafeInteger(v)) throw new Error(`deploy json: ${k} must be an integer`);
    if (ARRAY_FIELDS.includes(k) && !(Array.isArray(v) && v.every(isAddress))) throw new Error(`deploy json: ${k} must be an address list`);
  }
}

/** Merge `patch` into deploy/<cluster>.json (null deletes a field) and stamp updatedAt. Returns the new object. */
export function writeDeploy(cluster, patch) {
  const cur = readDeploy(cluster) ?? { cluster };
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  next.cluster = cluster;
  next.updatedAt = new Date().toISOString();
  validate(next);
  const order = ['cluster', 'genesisHash', 'programId', 'programDataSha256', 'programSoBytes', 'configPda', 'alt', 'altPending', 'altKeys', 'attestor', 'guardian', 'governance', 'upgradeAuthority', 'crank', 'faucet', 'deployer', 'squadsA', 'squadsAVault', 'squadsATimeLockSecs', 'squadsB', 'squadsBVault', 'squadsBTimeLockSecs', 'claimWindowSecs', 'rotationDelaySecs', 'flavor'];
  const sorted = {};
  for (const k of order) if (k in next) sorted[k] = next[k];
  for (const k of Object.keys(next).sort()) if (!(k in sorted)) sorted[k] = next[k];
  mkdirSync(DEPLOY_DIR, { recursive: true });
  const p = deployPath(cluster);
  writeFileSync(`${p}.tmp`, `${JSON.stringify(sorted, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
  return sorted;
}
