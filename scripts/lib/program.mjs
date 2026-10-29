/**
 * Read-only views of the deployed shop-vault program (SPEC §11): program account, ProgramData (upgrade authority,
 * deployed bytes) and the local build artifacts. Shared by deploy-devnet.mjs and go-mainnet.mjs.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { b58encode } from './b58.mjs';
import { BPF_LOADER_UPGRADEABLE, PROGRAM_DATA_PDA, PROGRAM_DIR, PROGRAM_ID, SIMD_0500_FEATURE } from './paths.mjs';
import { getAccount } from './rpc.mjs';

/** Local artifacts: mainnet = target/deploy, devnet = target/deploy-devnet (never mixed, SPEC D10/T18). */
export function artifactPath(cluster) {
  return join(PROGRAM_DIR, 'target', cluster === 'mainnet' ? 'deploy' : 'deploy-devnet', 'shop_vault.so');
}

/** { path, bytes, sha256, eFlags, hasMarker, hasOtherMarker } or null when missing. */
export function artifactInfo(cluster) {
  const path = artifactPath(cluster);
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  const other = cluster === 'mainnet' ? 'devnet' : 'mainnet';
  return {
    path,
    bytes: statSync(path).size,
    sha256: createHash('sha256').update(buf).digest('hex'),
    // ELF64 e_flags at offset 48: 0 = SBPF v0 (deployable only while SIMD-0500 is inactive), 3 = SBPF v3.
    eFlags: buf.length > 52 ? buf.readUInt32LE(48) : null,
    hasMarker: buf.includes(Buffer.from(`shop-vault-build:${cluster}`)),
    hasOtherMarker: buf.includes(Buffer.from(`shop-vault-build:${other}`)),
  };
}

/**
 * The deployed program on the cluster behind `url`:
 * { exists, executable, upgradeAuthority (base58|null = immutable), programDataLen, deployedSha256(len) }.
 */
export async function deployedProgram(url) {
  const prog = await getAccount(url, PROGRAM_ID);
  if (!prog) return { exists: false };
  const pd = await getAccount(url, PROGRAM_DATA_PDA);
  const out = { exists: true, executable: prog.executable, owner: prog.owner, programDataLen: pd?.data.length ?? 0, upgradeAuthority: null };
  if (pd && pd.owner === BPF_LOADER_UPGRADEABLE && pd.data.length >= 45 && pd.data.readUInt32LE(0) === 3) {
    out.upgradeAuthority = pd.data[12] === 1 ? b58encode(pd.data.subarray(13, 45)) : null;
    out.programBytes = pd.data.subarray(45);
  }
  /** sha256 of the first `len` deployed bytes (compare with the local artifact of that length). */
  out.deployedSha256 = (len) => (out.programBytes ? createHash('sha256').update(out.programBytes.subarray(0, len)).digest('hex') : null);
  return out;
}

/** True when SIMD-0500 ("disable deployment of SBPF v0-v2") is active on the cluster (feature account activated). */
export async function simd0500Active(url) {
  const a = await getAccount(url, SIMD_0500_FEATURE);
  // Feature account: Option<u64> activated_at (tag byte 1 = Some).
  return !!(a && a.data.length >= 1 && a.data[0] === 1);
}

/** Program deploy rent estimate in lamports: ProgramData (45 + len) + program account (36) + buffer (37 + len). */
export async function programDeployCost(url, soBytes, rentExempt) {
  const programData = await rentExempt(url, 45 + soBytes);
  const programAccount = await rentExempt(url, 36);
  const buffer = await rentExempt(url, 37 + soBytes);
  // ~1 write tx per ~1 KB of program (5,000 lamports each) + deploy + slack.
  const fees = BigInt(Math.ceil(soBytes / 1000) + 10) * 5000n;
  return { programData, programAccount, buffer, fees, locked: programData + programAccount, peak: programData + programAccount + buffer + fees };
}
