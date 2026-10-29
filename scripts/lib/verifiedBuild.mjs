/**
 * The reproducible program build from CI (.github/workflows/verifiable-build.yml): `solana-verify build` runs in
 * Docker on GitHub's runner and uploads `shop-vault-verified-<sha>` = shop_vault.so + shop_vault.so.sha256 +
 * build-info.json. The owner downloads and unzips it, copies shop_vault.so to programs/shop-vault/target/deploy/, and
 * passes `--verified-artifact <unzipped dir>` to go-mainnet: the "verified build" check then compares hashes instead of
 * rebuilding locally, so the deploy needs no Docker on the owner's Mac, provided the program source here is that
 * commit's (sourceDriftProblems). Anyone can still reproduce the hash with `solana-verify build` from the recorded
 * commit.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HEX64 = /^[0-9a-f]{64}$/;

/** Reads the unzipped CI artifact dir → { info, soSha256, sumSha256 } (missing parts are null). */
export function readVerifiedArtifact(dir) {
  const so = join(dir, 'shop_vault.so');
  const sum = join(dir, 'shop_vault.so.sha256');
  const infoPath = join(dir, 'build-info.json');
  let info = null;
  try {
    info = existsSync(infoPath) ? JSON.parse(readFileSync(infoPath, 'utf8')) : null;
  } catch {
    info = null;
  }
  return {
    info,
    soSha256: existsSync(so) ? createHash('sha256').update(readFileSync(so)).digest('hex') : null,
    sumSha256: existsSync(sum) ? (readFileSync(sum, 'utf8').trim().split(/\s+/)[0] ?? '').toLowerCase() : null,
  };
}

/**
 * Problems with using the CI build as the verified artifact (empty = the candidate IS the CI solana-verify build).
 * @param {{ info: object|null, soSha256: string|null, sumSha256: string|null }} ci
 * @param {string} candidateSha256  sha256 of programs/shop-vault/target/deploy/shop_vault.so
 */
export function verifiedArtifactProblems(ci, candidateSha256) {
  const p = [];
  if (!ci.soSha256) p.push('shop_vault.so missing in the artifact dir');
  if (!ci.sumSha256 || !HEX64.test(ci.sumSha256)) p.push('shop_vault.so.sha256 missing or malformed');
  if (!ci.info) p.push('build-info.json missing or not JSON');
  else {
    if (ci.info.flavour !== 'mainnet') p.push(`build-info.json flavour is ${JSON.stringify(ci.info.flavour)}, expected "mainnet"`);
    if (ci.info.sha256 !== ci.sumSha256) p.push('build-info.json sha256 ≠ shop_vault.so.sha256');
    if (typeof ci.info.commit !== 'string' || !/^[0-9a-f]{40}$/.test(ci.info.commit)) p.push('build-info.json has no commit sha');
  }
  if (ci.soSha256 && ci.sumSha256 && ci.soSha256 !== ci.sumSha256) p.push('shop_vault.so does not match its .sha256 file (corrupt download?)');
  if (ci.sumSha256 && candidateSha256 !== ci.sumSha256) p.push('target/deploy/shop_vault.so is not the CI build: copy shop_vault.so from the artifact dir there');
  return p;
}

/** The inputs of the program binary (what solana-verify builds from programs/shop-vault). */
export const PROGRAM_SOURCE_PATHS = ['programs/shop-vault/src', 'programs/shop-vault/Cargo.toml', 'programs/shop-vault/Cargo.lock'];

/**
 * Problems when the program source in this checkout (working tree, uncommitted edits included) differs from the commit
 * the CI artifact was built from: the local `--verify` rebuilds THIS source, so the CI build must be of the same source,
 * or the deploy would ship a binary of other code than the code tested and reviewed here.
 * @param {unknown} commit  build-info.json `commit` (malformed values are reported by verifiedArtifactProblems)
 * @param {(args: string[]) => Promise<{ code: number, out: string }>} git  runs git in the repo root
 */
export async function sourceDriftProblems(commit, git) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return [];
  const short = commit.slice(0, 12);
  if ((await git(['cat-file', '-e', `${commit}^{commit}`])).code !== 0) return [`the CI build's commit ${short} is not in this clone: git fetch (or build from a commit you pushed)`];
  const d = await git(['diff', '--name-only', commit, '--', ...PROGRAM_SOURCE_PATHS]);
  if (d.code !== 0) return [`git diff against the CI build's commit ${short} failed`];
  const files = d.out.trim().split('\n').filter(Boolean);
  if (!files.length) return [];
  return [`the program source here differs from the CI build's commit ${short} (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}): run the Verifiable build workflow on the commit you deploy`];
}
