/**
 * Squads v4 (program SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf) read-only helpers for go-mainnet's governance
 * checks (SPEC §11, T11/T11b): decode a Multisig account and derive its vault PDA. The script never holds a member key.
 *
 * Multisig account (Anchor, 8-byte discriminator):
 *   create_key:32 · config_authority:32 · threshold:u16 · time_lock:u32 · transaction_index:u64 ·
 *   stale_transaction_index:u64 · rent_collector:Option<Pubkey> · bump:u8 · members:Vec<{key:32, permissions:u8}>
 * Vault PDA: ["multisig", multisig, "vault", u8 index] under the Squads program.
 */
import { b58encode } from './b58.mjs';
import { SQUADS_V4_PROGRAM } from './paths.mjs';

const ZERO = '11111111111111111111111111111111';

/** @param {Buffer|Uint8Array} data */
export function decodeMultisig(data) {
  const d = Buffer.from(data);
  if (d.length < 8 + 32 + 32 + 2 + 4 + 8 + 8 + 1 + 1 + 4) throw new Error('not a Squads v4 multisig (too short)');
  let o = 8;
  const createKey = b58encode(d.subarray(o, o + 32));
  o += 32;
  const configAuthority = b58encode(d.subarray(o, o + 32));
  o += 32;
  const threshold = d.readUInt16LE(o);
  o += 2;
  const timeLock = d.readUInt32LE(o);
  o += 4;
  const transactionIndex = d.readBigUInt64LE(o);
  o += 8;
  o += 8; // stale_transaction_index
  const rcTag = d[o];
  o += 1;
  let rentCollector = null;
  if (rcTag === 1) {
    rentCollector = b58encode(d.subarray(o, o + 32));
    o += 32;
  } else if (rcTag !== 0) throw new Error('not a Squads v4 multisig (rent_collector tag)');
  o += 1; // bump
  const n = d.readUInt32LE(o);
  o += 4;
  if (n > 65 || o + n * 33 > d.length) throw new Error('not a Squads v4 multisig (members)');
  const members = [];
  for (let i = 0; i < n; i++) {
    members.push({ key: b58encode(d.subarray(o, o + 32)), permissions: d[o + 32] });
    o += 33;
  }
  return {
    createKey,
    configAuthority: configAuthority === ZERO ? null : configAuthority,
    threshold,
    timeLock,
    transactionIndex,
    rentCollector,
    members,
  };
}

/** Squads v4 permission bits: 1 Initiate, 2 Vote, 4 Execute. */
export const SQUADS_PERMISSION = { Initiate: 1, Vote: 2, Execute: 4 };

/** Vault PDA (string) of a multisig. web3.js is loaded lazily. */
export async function squadsVaultPda(multisig, index = 0) {
  const { web3 } = await import('./web3.mjs');
  const [pda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from('multisig'), new web3.PublicKey(multisig).toBuffer(), Buffer.from('vault'), Buffer.of(index)],
    new web3.PublicKey(SQUADS_V4_PROGRAM),
  );
  return pda.toBase58();
}

/**
 * Governance rules from SPEC §11 / T11b for a decoded multisig. Returns problem strings (empty = ok).
 * @param {ReturnType<typeof decodeMultisig>} ms
 * @param {{ role: 'governance'|'upgrade', claimWindowSecs: number }} o
 */
export function multisigProblems(ms, { role, claimWindowSecs }) {
  const p = [];
  const voters = ms.members.filter((m) => m.permissions & SQUADS_PERMISSION.Vote).length;
  if (ms.threshold < 2) p.push(`threshold is ${ms.threshold}; needs at least 2 (2-of-3 hardware keys)`);
  if (voters < 3) p.push(`${voters} voting members; needs at least 3`);
  if (ms.threshold > voters) p.push(`threshold ${ms.threshold} exceeds the ${voters} voting members (the multisig could never execute)`);
  if (ms.configAuthority) p.push(`config_authority is set (${ms.configAuthority}): one key could change members or the time lock; use an autonomous multisig`);
  if (role === 'governance' && !(ms.timeLock + 86_400 < claimWindowSecs)) {
    p.push(`time lock ${ms.timeLock} s must be < claim window ${claimWindowSecs} s − 24 h (SPEC T11b)`);
  }
  return p;
}
