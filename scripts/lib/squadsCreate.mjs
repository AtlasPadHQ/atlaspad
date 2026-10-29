/**
 * Squads v4 multisig_create_v2, encoded by hand (no @sqds/multisig dependency). Used by scripts/create-squads.mjs.
 *
 * Checked against the published Squads v4 IDL (squads_multisig_program 2.1.0, Anchor 0.29) and the program source
 * (programs/squads_multisig_program/src/instructions/multisig_create.rs, state/multisig.rs, state/seeds.rs):
 *
 *   data     = sha256("global:multisig_create_v2")[0..8] ‖ Borsh(MultisigCreateArgsV2)
 *   args     = config_authority: Option<Pubkey> · threshold: u16 · members: Vec<{ key: Pubkey, permissions: { mask: u8 } }>
 *              · time_lock: u32 · rent_collector: Option<Pubkey> · memo: Option<String>
 *   accounts = program_config (read) · treasury (writable; must equal ProgramConfig.treasury) · multisig (writable,
 *              PDA ["multisig", "multisig", create_key]) · create_key (signer) · creator (signer, writable, pays rent
 *              and the creation fee) · system_program
 *   ProgramConfig PDA ["multisig", "program_config"]: authority:32 · multisig_creation_fee:u64 · treasury:32 · reserved:64
 *   Multisig::size(n) = 8+32+32+2+4+8+8+1+32+1+4 + 33·n (rent_collector always reserves 32 bytes)
 *   On chain the program sorts the members by key and requires: no duplicates, mask < 8, ≥ 1 proposer/voter/executor,
 *   0 < threshold ≤ voters, time_lock ≤ 3 × 30 days.
 * Read-only decoding of the created account stays in ./squads.mjs (decodeMultisig, squadsVaultPda).
 */
import { createHash } from 'node:crypto';
import { b58decode, b58encode, isAddress } from './b58.mjs';
import { SQUADS_V4_PROGRAM } from './paths.mjs';

const anchorDisc = (s) => createHash('sha256').update(s).digest().subarray(0, 8);

export const MULTISIG_CREATE_V2_DISCRIMINATOR = anchorDisc('global:multisig_create_v2');
export const MULTISIG_ACCOUNT_DISCRIMINATOR = anchorDisc('account:Multisig');
export const PROGRAM_CONFIG_DISCRIMINATOR = anchorDisc('account:ProgramConfig');
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** Initiate | Vote | Execute. */
export const ALL_PERMISSIONS = 7;
/** state/multisig.rs MAX_TIME_LOCK: 3 × 30 days. */
export const MAX_TIME_LOCK = 7_776_000;

/** Bytes of a Multisig account with `n` members (Multisig::size). */
export function multisigAccountSize(n) {
  return 8 + 32 + 32 + 2 + 4 + 8 + 8 + 1 + 32 + 1 + 4 + 33 * n;
}

function key32(k, what) {
  if (!isAddress(k)) throw new Error(`${what} is not a base58 address`);
  return Buffer.from(b58decode(k));
}

function optPubkey(k, what) {
  return k == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), key32(k, what)]);
}

/**
 * Instruction data for multisig_create_v2.
 * @param {{ configAuthority?: string|null, threshold: number, members: { key: string, permissions?: number }[],
 *           timeLock: number, rentCollector?: string|null, memo?: string|null }} a
 */
export function encodeMultisigCreateV2(a) {
  const { configAuthority = null, threshold, members, timeLock, rentCollector = null, memo = null } = a;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 0xffff) throw new Error(`threshold ${threshold} is not a u16 ≥ 1`);
  if (!Array.isArray(members) || members.length < 1 || members.length > 0xffff) throw new Error('members must be a non-empty list');
  if (!Number.isInteger(timeLock) || timeLock < 0 || timeLock > MAX_TIME_LOCK) throw new Error(`time lock ${timeLock} s is outside 0..${MAX_TIME_LOCK}`);
  const head = Buffer.alloc(2);
  head.writeUInt16LE(threshold);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(members.length);
  const ms = members.map((m, i) => {
    const mask = m.permissions ?? ALL_PERMISSIONS;
    if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new Error(`member ${i + 1}: permission mask ${mask} is not 0..7`);
    return Buffer.concat([key32(m.key, `member ${i + 1}`), Buffer.from([mask])]);
  });
  const tl = Buffer.alloc(4);
  tl.writeUInt32LE(timeLock);
  let memoBytes = Buffer.from([0]);
  if (memo != null) {
    const s = Buffer.from(String(memo), 'utf8');
    const l = Buffer.alloc(4);
    l.writeUInt32LE(s.length);
    memoBytes = Buffer.concat([Buffer.from([1]), l, s]);
  }
  return Buffer.concat([
    MULTISIG_CREATE_V2_DISCRIMINATOR,
    optPubkey(configAuthority, 'config authority'),
    head,
    len,
    ...ms,
    tl,
    optPubkey(rentCollector, 'rent collector'),
    memoBytes,
  ]);
}

/**
 * Account metas for multisig_create_v2, in IDL order (base58 strings; the caller turns them into PublicKeys).
 * @returns {{ pubkey: string, isSigner: boolean, isWritable: boolean }[]}
 */
export function multisigCreateV2Accounts({ programConfig, treasury, multisig, createKey, creator }) {
  return [
    { pubkey: programConfig, isSigner: false, isWritable: false },
    { pubkey: treasury, isSigner: false, isWritable: true },
    { pubkey: multisig, isSigner: false, isWritable: true },
    { pubkey: createKey, isSigner: true, isWritable: false },
    { pubkey: creator, isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
  ];
}

/** A web3.js TransactionInstruction for multisig_create_v2 (web3 loaded lazily). */
export async function multisigCreateV2Ix(accounts, args) {
  const { web3 } = await import('./web3.mjs');
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(SQUADS_V4_PROGRAM),
    keys: multisigCreateV2Accounts(accounts).map((m) => ({ ...m, pubkey: new web3.PublicKey(m.pubkey) })),
    data: encodeMultisigCreateV2(args),
  });
}

/** ProgramConfig PDA (string). */
export async function programConfigPda() {
  const { web3 } = await import('./web3.mjs');
  const [pda] = web3.PublicKey.findProgramAddressSync([Buffer.from('multisig'), Buffer.from('program_config')], new web3.PublicKey(SQUADS_V4_PROGRAM));
  return pda.toBase58();
}

/** Multisig PDA (string) for a create key. */
export async function multisigPda(createKey) {
  const { web3 } = await import('./web3.mjs');
  const [pda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from('multisig'), Buffer.from('multisig'), new web3.PublicKey(createKey).toBuffer()],
    new web3.PublicKey(SQUADS_V4_PROGRAM),
  );
  return pda.toBase58();
}

/** Decode the ProgramConfig account: { authority, multisigCreationFee (bigint), treasury }. */
export function decodeProgramConfig(data) {
  const d = Buffer.from(data);
  if (d.length < 8 + 32 + 8 + 32) throw new Error('not a Squads v4 ProgramConfig (too short)');
  if (!d.subarray(0, 8).equals(PROGRAM_CONFIG_DISCRIMINATOR)) throw new Error('not a Squads v4 ProgramConfig (discriminator)');
  return {
    authority: b58encode(d.subarray(8, 40)),
    multisigCreationFee: d.readBigUInt64LE(40),
    treasury: b58encode(d.subarray(48, 80)),
  };
}

/** True when the account data starts with the Anchor Multisig discriminator. */
export function isMultisigAccount(data) {
  const d = Buffer.from(data);
  return d.length >= 8 && d.subarray(0, 8).equals(MULTISIG_ACCOUNT_DISCRIMINATOR);
}
