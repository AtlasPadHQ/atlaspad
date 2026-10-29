// node --test scripts/test/   create-squads.mjs + lib/squadsCreate.mjs: Squads v4 multisig_create_v2 encoding, PDAs,
// input validation, the dry-run plan and the public record. No network: the devnet fixtures below were captured from
// the pair create-squads.mjs created on 2026-10-26 (deploy/devnet-squads.json).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CONFIRM_PHRASE,
  createdProblems,
  FEE_MARGIN,
  goMainnetFlags,
  humanDuration,
  memberProblems,
  pairProblems,
  parseMembers,
  payerErrorMessage,
  payerNeed,
  planLines,
  readSquadsRecord,
  recordProblems,
  SQUADS_SPECS,
  squadsRecordPath,
  THRESHOLD,
  txFeeEstimate,
  writeSquadsRecord,
} from '../create-squads.mjs';
import { b58decode, b58encode } from '../lib/b58.mjs';
import { ensureKey } from '../lib/keys.mjs';
import { PROGRAM_ID, ROOT, SQUADS_V4_PROGRAM } from '../lib/paths.mjs';
import { decodeMultisig, multisigProblems, squadsVaultPda } from '../lib/squads.mjs';
import {
  ALL_PERMISSIONS,
  decodeProgramConfig,
  encodeMultisigCreateV2,
  isMultisigAccount,
  MAX_TIME_LOCK,
  MULTISIG_ACCOUNT_DISCRIMINATOR,
  MULTISIG_CREATE_V2_DISCRIMINATOR,
  multisigAccountSize,
  multisigCreateV2Accounts,
  multisigCreateV2Ix,
  multisigPda,
  PROGRAM_CONFIG_DISCRIMINATOR,
  programConfigPda,
  SYSTEM_PROGRAM,
} from '../lib/squadsCreate.mjs';
import { web3 } from '../lib/web3.mjs';

const K1 = b58encode(new Uint8Array(32).fill(1));
const K2 = b58encode(new Uint8Array(32).fill(2));
const K3 = b58encode(new Uint8Array(32).fill(3));

// devnet, 2026-10-26 (create-squads.mjs --execute, payer = the devnet deployer, three throwaway members)
const DEV = {
  members: ['5Up6rFWKX62FweeQhADZBMFejQvdzNPLHngY8H9Xjy3u', 'DDCs2dioYCnQ5Du9BJa2CN22hFrJjf79CqwAU5w3va4y', 'H9uo8AFTo5xGn487GVuwgPqvMV16TN4nh7sTtN8BE5c2'],
  payer: 'GNm79FtEQQx41LYfVbU9xDQaFDRVQyZ8q85DAWoHe6Bw',
  treasury: 'HM5y4mz3Bt9JY9mr1hkyhnvqxSH4H2u2451j7Hc2dtvK',
  A: {
    multisig: '8uREw7ywaumQVeo3asLtHaxkZ5fF7frW6EsSmugKMT9Q',
    createKey: 'Bup39sJ7z3rd8M8d98rKBtZwPFG9yVR53MFnJParmp7A',
    vault: '3Tfwv7ETyPVC5FJD9tXZ1DHc3H4oQGzebqwFvwzNFqrT',
    signature: '4sNsJdcb7GnsuYxoBZu6dPo6xpeU7UXPqpGDfsU6WaWM5UTS4U15CQhCUAr1zgDfkYx8x58hVygyVvjT3HsxiMmd',
    data: '4HR5ukShT+yiHEGhy4k9qH4qWsD/lsaF3TD6ht5eNRRABoMvhbtokQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AwAAAEKOr8gs/WFi9YKWAf/T9fi81/3FLOxhn3xiHmpIhQZ4B7VsoDg+Ba+lo9PKlmlhXXPqfHoFtdLSIRYzbi4st1gyB/ADVUL24x/2XRkpVo1xvmO43L2N1ob/knmkupM4h3tHBwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    // the instruction data of tx 4sNsJdcb… exactly as it landed (base58, from getTransaction)
    ixData: '83w4mp6nQUf4Bb1Ba2k6rtvjFZ1R3DgM8eL6EFGbUhFLBVp3XNeCqPfak973ogvUnoG9mGzLWQkW7XdKtcrXZ1ckkBaxK4sS4f6RwseLtuYZ9w8AXpWYf7R6emqbHkDbCKXc13jJ7777Q5aH8UMGxch8LaHwj6uB6TUK',
  },
  B: {
    multisig: 'HJS8io82jwZLtoFMvGsUsV3vvrH3VhUfArTskyEfRmm7',
    createKey: '8ZyEsWU5oBNbcAbbjx1W5ma2qepHy6TBgaphk4xdpQ29',
    vault: 'APkKUQNnN3hG9W5MoMBDBFiMxmmb7KYyH5BeyWCAw9ee',
    data: '4HR5ukShT+xwc/vzrfc5pbrU8yl5/TdJVa6fsrk2k+oCLSuuS1n3tgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgCAOgkAAAAAAAAAAAAAAAAAAAAAAAD/AwAAAEKOr8gs/WFi9YKWAf/T9fi81/3FLOxhn3xiHmpIhQZ4B7VsoDg+Ba+lo9PKlmlhXXPqfHoFtdLSIRYzbi4st1gyB/ADVUL24x/2XRkpVo1xvmO43L2N1ob/knmkupM4h3tHBwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  },
};

test('squads: Anchor discriminators (IDL squads_multisig_program 2.1.0; SDK multisigCreateV2InstructionDiscriminator)', () => {
  assert.equal(MULTISIG_CREATE_V2_DISCRIMINATOR.toString('hex'), '32ddc75d28f58be9');
  assert.deepEqual([...MULTISIG_CREATE_V2_DISCRIMINATOR], [50, 221, 199, 93, 40, 245, 139, 233]);
  assert.equal(MULTISIG_ACCOUNT_DISCRIMINATOR.toString('hex'), 'e07479ba44a14fec');
  assert.equal(PROGRAM_CONFIG_DISCRIMINATOR.toString('hex'), 'c4d25ae790958c3f'); // = the first 8 bytes of BSTq9w3k… on both clusters
});

test('squads: multisig_create_v2 data against hand-computed Borsh bytes', () => {
  const members = [K1, K2, K3].map((key) => ({ key, permissions: 7 }));
  const b = encodeMultisigCreateV2({ threshold: 2, members, timeLock: 604_800 });
  const want =
    '32ddc75d28f58be9' + // sha256("global:multisig_create_v2")[0..8]
    '00' + // config_authority: None (autonomous)
    '0200' + // threshold u16 = 2
    '03000000' + // members: Vec len u32 = 3
    `${'01'.repeat(32)}07` + // { key, permissions { mask: 7 } }
    `${'02'.repeat(32)}07` +
    `${'03'.repeat(32)}07` +
    '803a0900' + // time_lock u32 = 604800 = 0x00093a80
    '00' + // rent_collector: None
    '00'; // memo: None
  assert.equal(b.toString('hex'), want);
  assert.equal(b.length, 120);
  // time lock 0, and the Some(...) encodings
  assert.equal(encodeMultisigCreateV2({ threshold: 2, members, timeLock: 0 }).subarray(114, 118).toString('hex'), '00000000');
  const some = encodeMultisigCreateV2({ threshold: 1, members: [{ key: K1 }], timeLock: 1, configAuthority: K2, rentCollector: K3, memo: 'hi' });
  assert.equal(
    some.toString('hex'),
    `32ddc75d28f58be9` + `01${'02'.repeat(32)}` + '0100' + '01000000' + `${'01'.repeat(32)}07` + '01000000' + `01${'03'.repeat(32)}` + '01' + '02000000' + '6869',
  );
  // the program's own invariants are refused before anything is signed
  assert.throws(() => encodeMultisigCreateV2({ threshold: 0, members, timeLock: 0 }), /threshold/);
  assert.throws(() => encodeMultisigCreateV2({ threshold: 2, members, timeLock: MAX_TIME_LOCK + 1 }), /time lock/);
  assert.throws(() => encodeMultisigCreateV2({ threshold: 2, members: [{ key: K1, permissions: 8 }], timeLock: 0 }), /mask/);
  assert.throws(() => encodeMultisigCreateV2({ threshold: 2, members: [{ key: 'nope' }], timeLock: 0 }), /member 1/);
  assert.throws(() => encodeMultisigCreateV2({ threshold: 2, members: [], timeLock: 0 }), /members/);
});

test('squads: the encoder reproduces the instruction that created devnet Squads A byte for byte', () => {
  const b = encodeMultisigCreateV2({ threshold: THRESHOLD, members: DEV.members.map((key) => ({ key, permissions: ALL_PERMISSIONS })), timeLock: 0 });
  assert.equal(b.toString('hex'), Buffer.from(b58decode(DEV.A.ixData)).toString('hex'));
});

test('squads: multisig_create_v2 accounts in IDL order with the right signer/writable flags', async () => {
  const metas = multisigCreateV2Accounts({ programConfig: 'BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr', treasury: DEV.treasury, multisig: DEV.A.multisig, createKey: DEV.A.createKey, creator: DEV.payer });
  assert.deepEqual(
    metas.map((m) => [m.pubkey, m.isSigner, m.isWritable]),
    [
      ['BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr', false, false], // program_config
      [DEV.treasury, false, true], // treasury
      [DEV.A.multisig, false, true], // multisig (init)
      [DEV.A.createKey, true, false], // create_key
      [DEV.payer, true, true], // creator (payer)
      [SYSTEM_PROGRAM, false, false], // system_program
    ],
  );
  const ix = await multisigCreateV2Ix(
    { programConfig: 'BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr', treasury: DEV.treasury, multisig: DEV.A.multisig, createKey: DEV.A.createKey, creator: DEV.payer },
    { threshold: 2, members: DEV.members.map((key) => ({ key })), timeLock: 0 },
  );
  assert.equal(ix.programId.toBase58(), SQUADS_V4_PROGRAM);
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), metas.map((m) => m.pubkey));
  assert.equal(Buffer.from(ix.data).toString('hex'), Buffer.from(b58decode(DEV.A.ixData)).toString('hex'));
});

test('squads: PDAs (ProgramConfig, multisig from create key, vault 0) match the chain', async () => {
  assert.equal(await programConfigPda(), 'BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr');
  for (const x of [DEV.A, DEV.B]) {
    assert.equal(await multisigPda(x.createKey), x.multisig);
    assert.equal(await squadsVaultPda(x.multisig, 0), x.vault);
  }
  assert.equal(multisigAccountSize(3), 231);
});

test('squads: the created devnet accounts decode as 2-of-3, the right time locks, autonomous', () => {
  for (const [x, spec] of [[DEV.A, SQUADS_SPECS[0]], [DEV.B, SQUADS_SPECS[1]]]) {
    const data = Buffer.from(x.data, 'base64');
    assert.equal(data.length, multisigAccountSize(3));
    assert.ok(isMultisigAccount(data));
    const ms = decodeMultisig(data);
    assert.equal(ms.createKey, x.createKey);
    assert.equal(ms.threshold, 2);
    assert.equal(ms.timeLock, spec.timeLock);
    assert.equal(ms.configAuthority, null);
    assert.equal(ms.rentCollector, null);
    assert.deepEqual(ms.members.map((m) => m.permissions), [7, 7, 7]);
    assert.deepEqual(ms.members.map((m) => m.key).sort(), [...DEV.members].sort());
    assert.deepEqual(createdProblems(ms, { timeLock: spec.timeLock, members: DEV.members }), []);
    assert.deepEqual(multisigProblems(ms, { role: spec.role, claimWindowSecs: 259_200 }), []);
  }
  assert.equal(SQUADS_SPECS[0].timeLock, 0);
  assert.equal(SQUADS_SPECS[1].timeLock, 604_800);
  assert.ok(!isMultisigAccount(Buffer.alloc(231)));
});

test('squads: createdProblems catches every way a read-back can be wrong', () => {
  const ms = decodeMultisig(Buffer.from(DEV.B.data, 'base64'));
  const p = (o, want = {}) => createdProblems({ ...ms, ...o }, { timeLock: 604_800, members: DEV.members, ...want });
  assert.ok(p({ threshold: 1 }).some((x) => /threshold is 1, expected 2/.test(x)));
  assert.ok(p({ timeLock: 0 }).some((x) => /time lock is 0 s, expected 604800 s/.test(x)));
  assert.ok(p({ configAuthority: K1 }).some((x) => /config authority/.test(x)));
  assert.ok(p({ rentCollector: K1 }).some((x) => /rent collector/.test(x)));
  assert.ok(p({ members: ms.members.slice(0, 2) }).some((x) => /2 members, expected 3/.test(x)));
  assert.ok(p({ members: ms.members.map((m, i) => (i ? m : { ...m, permissions: 3 })) }).some((x) => /mask 3/.test(x)));
  assert.ok(p({}, { members: [K1, K2, K3] }).some((x) => /not the requested ones/.test(x)));
});

test('squads: ProgramConfig decode (treasury and fee are read, never hard-coded)', () => {
  const d = Buffer.concat([PROGRAM_CONFIG_DISCRIMINATOR, Buffer.alloc(32, 1), Buffer.alloc(8), Buffer.from(b58decode(DEV.treasury)), Buffer.alloc(64)]);
  d.writeBigUInt64LE(123_456n, 40);
  assert.deepEqual(decodeProgramConfig(d), { authority: K1, multisigCreationFee: 123_456n, treasury: DEV.treasury });
  assert.throws(() => decodeProgramConfig(Buffer.concat([Buffer.alloc(8), d.subarray(8)])), /discriminator/);
  assert.throws(() => decodeProgramConfig(Buffer.alloc(20)), /too short/);
});

test('create-squads: --members must be 3 distinct valid addresses; rejected values are never echoed', () => {
  assert.deepEqual(parseMembers(DEV.members.join(',')), { members: DEV.members, problems: [] });
  assert.deepEqual(parseMembers(` ${DEV.members.join(' , ')} `).problems, []);
  assert.ok(parseMembers(undefined).problems.some((p) => /required/.test(p)));
  assert.ok(parseMembers(true).problems.some((p) => /required/.test(p)));
  assert.ok(parseMembers(DEV.members.slice(0, 2).join(',')).problems.some((p) => /exactly 3 members are needed, got 2/.test(p)));
  assert.ok(parseMembers([...DEV.members, K1].join(',')).problems.some((p) => /got 4/.test(p)));
  assert.ok(parseMembers([DEV.members[0], DEV.members[0], DEV.members[1]].join(',')).problems.some((p) => /listed twice/.test(p)));
  assert.ok(parseMembers(`${DEV.members[0]},${DEV.members[1]},`).problems.some((p) => /member 3 is not a valid address \(0 characters\)/.test(p)));
  const secret = b58encode(new Uint8Array(64).fill(7));
  const r = parseMembers(`${DEV.members[0]},${DEV.members[1]},${secret}`);
  assert.ok(r.problems.some((p) => /SECRET key/.test(p)));
  assert.ok(!r.problems.join(' ').includes(secret));
  assert.ok(!parseMembers(`${DEV.members[0]},${DEV.members[1]},0OIl-not-base58`).problems.join(' ').includes('0OIl'));
});

test('create-squads: members are never the payer, attestor, crank, deployer, a program id, a PDA or (mainnet) a hot key', () => {
  const isOnCurve = (a) => web3.PublicKey.isOnCurve(new web3.PublicKey(a).toBytes());
  const base = { cluster: 'mainnet', payer: K1, roles: { attestor: K2, crank: K3 }, isOnCurve };
  assert.deepEqual(memberProblems({ ...base, members: DEV.members }), { fail: [], warn: [] });
  const fails = (members, extra = {}) => memberProblems({ ...base, members, ...extra }).fail.join('\n');
  assert.match(fails([K1, DEV.members[1], DEV.members[2]]), /member 1 .* is the payer/);
  assert.match(fails([DEV.members[0], K2, DEV.members[2]]), /member 2 .* is the attestor/);
  assert.match(fails([DEV.members[0], DEV.members[1], K3]), /member 3 .* is the crank/);
  assert.match(fails([PROGRAM_ID, DEV.members[1], DEV.members[2]]), /shop-vault program id/);
  assert.match(fails([SQUADS_V4_PROGRAM, DEV.members[1], DEV.members[2]]), /Squads program/);
  assert.match(fails([DEV.payer, DEV.members[1], DEV.members[2]], { roles: { deployer: DEV.payer } }), /the deployer/);
  // a PDA (here the Squads ProgramConfig, and a vault) has no private key: refused
  assert.match(fails(['BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr', DEV.members[1], DEV.members[2]]), /off the ed25519 curve/);
  assert.match(fails([DEV.A.vault, DEV.members[1], DEV.members[2]]), /off the ed25519 curve/);
  // a key file on this machine: refused on mainnet, a warning on devnet
  const hotKeys = new Map([[DEV.members[0], 'mainnet-crank.json']]);
  assert.match(fails(DEV.members, { hotKeys }), /key file mainnet-crank\.json/);
  const dev = memberProblems({ ...base, cluster: 'devnet', members: DEV.members, hotKeys });
  assert.deepEqual(dev.fail, []);
  assert.match(dev.warn.join(), /key file/);
  // the guardian is a warning only
  const g = memberProblems({ ...base, members: DEV.members, guardian: DEV.members[2] });
  assert.deepEqual(g.fail, []);
  assert.match(g.warn.join(), /also the guardian/);
});

test('create-squads: payer need = rent for both + fees + margin; time lock wording', () => {
  // devnet 2026-10-26: rent 1,823,720 lamports per 231-byte multisig, 0 creation fee, no priority fee → 0.00866744 SOL
  assert.equal(txFeeEstimate(0), 10_000n);
  assert.equal(txFeeEstimate(10_000), 12_000n);
  assert.equal(payerNeed({ rentEach: 1_823_720n }), 2n * (1_823_720n + 10_000n) + FEE_MARGIN);
  assert.equal(payerNeed({ rentEach: 1_823_720n }), 8_667_440n);
  assert.equal(payerNeed({ rentEach: 2_498_640n, creationFee: 1_000_000n, count: 1, priorityMicroLamports: 10_000 }), 2_498_640n + 1_000_000n + 12_000n + FEE_MARGIN);
  assert.equal(payerNeed({ rentEach: 1_823_720n, count: 0 }), 0n);
  assert.equal(humanDuration(604_800), '7 days');
  assert.equal(humanDuration(86_400), '1 day');
  assert.equal(humanDuration(7_200), '2 hours');
  assert.equal(humanDuration(90), '90 s');
});

test('create-squads: the dry-run plan shows both multisigs, members, rent and payer', () => {
  const items = [
    { spec: SQUADS_SPECS[0], status: 'new', multisig: DEV.A.multisig, vault: DEV.A.vault, simUnits: 16_368 },
    { spec: SQUADS_SPECS[1], status: 'new', multisig: DEV.B.multisig, vault: DEV.B.vault },
  ];
  const p = {
    cluster: 'devnet',
    rpc: 'https://api.devnet.solana.com',
    payer: DEV.payer,
    balance: 230_737_035n,
    need: 8_667_440n,
    members: DEV.members,
    programConfig: 'BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr',
    treasury: DEV.treasury,
    creationFee: 0n,
    accountSize: 231,
    rentEach: 1_823_720n,
    priorityMicroLamports: 0,
    items,
  };
  const text = planLines(p).join('\n');
  assert.match(text, /Squads A \(governance\): 2-of-3 · time lock 0 s · autonomous \(no config authority\)/);
  assert.match(text, /Squads B \(program upgrade authority\): 2-of-3 · time lock 604800 s \(7 days\) · autonomous/);
  assert.match(text, new RegExp(`to create: multisig ${DEV.A.multisig} .*vault ${DEV.A.vault} · simulated OK, 16368 CU`));
  assert.match(text, new RegExp(`treasury ${DEV.treasury}, creation fee 0 SOL per multisig \\(read on chain\\)`));
  for (const [i, m] of DEV.members.entries()) assert.match(text, new RegExp(`${i + 1}\\. ${m}`));
  assert.match(text, /estimated cost: 2 × 231-byte account rent 0\.00182372 SOL = 0\.00364744 SOL .* \+ 0\.00002 SOL fees/);
  assert.match(text, new RegExp(`payer ${DEV.payer} \\(creator and fee payer\\): balance 0\\.230737035 SOL, needs ≥ 0\\.00866744 SOL`));
  const done = planLines({ ...p, items: items.map((i) => ({ ...i, status: 'created' })) }).join('\n');
  assert.match(done, /already created: multisig/);
  assert.match(done, /nothing to create/);
  assert.doesNotMatch(done, /estimated cost/);
});

test('create-squads: go-mainnet gets the MULTISIG addresses; pair rules (SPEC §11, T11b, I10)', () => {
  assert.equal(goMainnetFlags({ multisigA: DEV.A.multisig, multisigB: DEV.B.multisig }), `--squads-a ${DEV.A.multisig} --squads-b ${DEV.B.multisig}`);
  // go-mainnet reads --squads-a/--squads-b as Squads-owned multisig accounts and derives the vaults itself
  const gm = readFileSync(join(ROOT, 'scripts', 'go-mainnet.mjs'), 'utf8');
  assert.ok(gm.includes("[['squads-a', 'governance'], ['squads-b', 'upgrade']]"));
  assert.ok(gm.includes('acc.owner !== SQUADS_V4_PROGRAM') && gm.includes('squadsVaultPda(ms, 0)'));
  assert.deepEqual(SQUADS_SPECS.map((s) => [s.flag, s.role]), [['--squads-a', 'governance'], ['--squads-b', 'upgrade']]);
  const A = { multisig: DEV.A.multisig, vault: DEV.A.vault, timeLock: 0 };
  const B = { multisig: DEV.B.multisig, vault: DEV.B.vault };
  assert.deepEqual(pairProblems({ A, B, windowSecs: 259_200, roles: { attestor: K1, crank: K2, payer: DEV.payer } }), []);
  assert.ok(pairProblems({ A, B: { ...B, multisig: A.multisig }, windowSecs: 259_200 }).some((p) => /DIFFERENT multisigs/.test(p)));
  assert.ok(pairProblems({ A: { ...A, timeLock: 172_800 }, B, windowSecs: 259_200 }).some((p) => /time lock/.test(p)));
  assert.ok(pairProblems({ A, B, windowSecs: 259_200, roles: { attestor: DEV.A.vault } }).some((p) => /same key/.test(p)));
  assert.equal(CONFIRM_PHRASE, 'CREATE SQUADS ON MAINNET');
});

test('create-squads: deploy/<cluster>-squads.json holds public data only, merges and resumes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'squads-rec-'));
  assert.equal(readSquadsRecord('devnet', dir), null);
  assert.equal(squadsRecordPath('mainnet', dir), join(dir, 'mainnet-squads.json'));
  assert.throws(() => squadsRecordPath('testnet', dir), /cluster/);
  writeSquadsRecord('devnet', { squadsProgram: SQUADS_V4_PROGRAM, threshold: 2, timeLockA: 0, timeLockB: 604_800, members: DEV.members, pendingA: DEV.A.multisig }, dir);
  let rec = writeSquadsRecord('devnet', { multisigA: DEV.A.multisig, vaultA: DEV.A.vault, pendingA: null, signatures: { A: DEV.A.signature }, createdAt: '2026-10-26T16:41:37.423Z' }, dir);
  assert.equal(rec.pendingA, undefined);
  assert.equal(rec.multisigA, DEV.A.multisig);
  rec = readSquadsRecord('devnet', dir);
  assert.deepEqual(Object.keys(rec), ['cluster', 'squadsProgram', 'threshold', 'multisigA', 'vaultA', 'timeLockA', 'timeLockB', 'members', 'createdAt', 'updatedAt', 'signatures']);
  assert.throws(() => writeSquadsRecord('devnet', { secretKey: 'x' }, dir), /unknown field secretKey/);
  assert.throws(() => writeSquadsRecord('devnet', { vaultB: 'not-an-address' }, dir), /vaultB is not an address/);
  assert.throws(() => writeSquadsRecord('devnet', { signatures: { A: 'short' } }, dir), /signatures/);
  assert.throws(() => writeSquadsRecord('devnet', { members: DEV.members.slice(0, 2) }, dir), /3 addresses/);
  assert.deepEqual(readSquadsRecord('devnet', dir).multisigA, DEV.A.multisig); // refused writes changed nothing
  writeFileSync(join(dir, 'devnet-squads.json'), JSON.stringify({ cluster: 'devnet', seed: [1, 2] }));
  assert.throws(() => readSquadsRecord('devnet', dir), /unknown field seed/);
  // the committed records (deploy/<cluster>-squads.json) pass the same schema
  for (const cluster of ['devnet', 'mainnet']) {
    const f = join(ROOT, 'deploy', `${cluster}-squads.json`);
    if (existsSync(f)) assert.deepEqual(recordProblems(JSON.parse(readFileSync(f, 'utf8'))), [], f);
  }
});

test('create-squads CLI: usage errors exit 64 before any network call, and print no secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'squads-cli-'));
  const payer = ensureKey(join(dir, 'payer.json')).path;
  // an empty --deploy-dir, so the real deploy/<cluster>-squads.json records (a finished pair needs no --payer) never apply
  const run = (...a) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'create-squads.mjs'), '--deploy-dir', dir, ...a], { encoding: 'utf8', env: { ...process.env, RPC_URL: 'http://127.0.0.1:9' } });
  let r = run('--cluster', 'testnet');
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--cluster devnet\|mainnet is required/);
  r = run('--cluster', 'mainnet', '--members', DEV.members.join(','));
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--payer <keypair\.json> is required/);
  r = run('--cluster', 'mainnet', '--payer', payer);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--members/);
  const secret = b58encode(new Uint8Array(64).fill(9));
  r = run('--cluster', 'mainnet', '--payer', payer, '--members', `${DEV.members[0]},${DEV.members[1]},${secret}`);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /SECRET key/);
  assert.ok(!`${r.stdout}${r.stderr}`.includes(secret));
  const payerSecret = JSON.parse(readFileSync(payer, 'utf8'));
  assert.ok(!`${r.stdout}${r.stderr}`.includes(Buffer.from(payerSecret).toString('base64')));
  r = run('--cluster', 'mainnet', '--payer', payer, '--members', DEV.members.join(','), '--priority-fee', '5000000');
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--priority-fee/);
  r = run('--cluster', 'mainnet', '--payer', join(dir, 'missing.json'), '--members', DEV.members.join(','));
  assert.equal(r.status, 64);
  assert.match(r.stderr, /missing key file/);
  // a secret pasted where the payer FILE goes is never echoed (keys.mjs would build a path out of it)
  for (const pasted of [secret, `[${new Array(64).fill(9).join(',')}]`]) {
    r = run('--cluster', 'mainnet', '--payer', pasted, '--members', DEV.members.join(','));
    assert.equal(r.status, 64);
    assert.match(r.stderr, /--payer must be the path of a keypair FILE/);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(pasted));
  }
  // only a bare --execute sends: --execute=<anything> is refused before any network call
  for (const v of ['false', '0', 'no']) {
    r = run('--cluster', 'devnet', '--payer', payer, '--members', DEV.members.join(','), `--execute=${v}`);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /--execute is an on\/off flag/);
  }
  // mainnet --execute without an interactive terminal (no typed phrase possible) is refused before any network call
  r = run('--cluster', 'mainnet', '--payer', payer, '--members', DEV.members.join(','), '--execute');
  assert.equal(r.status, 64);
  assert.match(r.stderr, /mainnet --execute needs an interactive terminal/);
});

test('create-squads: payerErrorMessage echoes a .json path, never a pasted secret', () => {
  assert.equal(payerErrorMessage('~/wallet.json', 'missing key file /x/wallet.json'), '--payer: missing key file /x/wallet.json');
  const secret = b58encode(new Uint8Array(64).fill(7));
  for (const v of [secret, '[1,2,3]', `${secret}.json,`, undefined, true]) {
    const m = payerErrorMessage(v, `missing key file /x/${v}.json`);
    assert.match(m, /not echoed/);
    if (typeof v === 'string') assert.ok(!m.includes(v));
  }
});
