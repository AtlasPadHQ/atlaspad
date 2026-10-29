// node --test scripts/test/   guardian.mjs + guardian/app.mjs: the guardian's cancel_claim / set_paused transaction, the
// on-chain guardian check, the local page server and the page's wallet helpers. No network: a fake chain, fake wallets.
// What only a real Phantom can show (signing on the phone, the in-app browser reaching the laptop) is the devnet
// rehearsal in RUNBOOK §8 "Guardian".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { placeHashHex } from '../claims-admin.mjs';
import { actionProblems, createGuardianServer, FILES, guardianInstruction, guardianProblem, lanAddresses, prepare, unsignedTransaction } from '../guardian.mjs';
import { connectWallet, feePayerOf, fromBase64, pickWallet, signAndSend, signingProblem, walletRegistry } from '../guardian/app.mjs';
import { b58encode } from '../lib/b58.mjs';
import { CONFIG_PDA, PROGRAM_ID, ROOT } from '../lib/paths.mjs';
import { sv, web3 } from '../lib/web3.mjs';

const GUARDIAN = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
const OTHER = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
const CLAIMANT = '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt';
const BLOCKHASH = 'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s';
const PLACE = 'ChIJN1t_tDeuEmsRUsoyG83frY4';

/** A chain with one pending claim on PLACE (unlock at 2,000 s, now 1,000 s) unless told otherwise. */
function fakeChain({ paused = false, vault = true, pending = true, now = 1_000n, simErr = null } = {}) {
  const calls = { simulate: [], placeHash: null };
  return {
    calls,
    config: async () => ({ guardian: new web3.PublicKey(GUARDIAN), paused, flavor: 'mainnet' }),
    vaultState: async (ph) => {
      calls.placeHash = ph;
      if (!vault) return null;
      return { owner: null, pending: pending ? { owner: new web3.PublicKey(CLAIMANT), unlockTs: 2_000n, inProbation: false } : null };
    },
    now: async () => now,
    balance: async () => 2_500_000n,
    blockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 123 }),
    simulate: async (b64) => {
      calls.simulate.push(b64);
      return { err: simErr, logs: ['Program log: x'] };
    },
    status: async () => ({ confirmationStatus: 'confirmed', err: null }),
  };
}

test('guardian: cancel_claim and set_paused come from the shop-vault builders, guardian = signer', () => {
  const c = guardianInstruction({ sv, web3, action: 'cancel', placeId: PLACE, guardian: GUARDIAN });
  assert.equal(c.programId.toBase58(), PROGRAM_ID);
  assert.deepEqual([...c.data], [3]);
  assert.deepEqual(
    c.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [GUARDIAN, true, false],
      [CONFIG_PDA, false, false],
      [sv.vaultStatePda(Buffer.from(placeHashHex(PLACE), 'hex'))[0].toBase58(), false, true],
    ],
  );
  for (const [action, flag] of [['pause', 1], ['unpause', 0]]) {
    const p = guardianInstruction({ sv, web3, action, guardian: GUARDIAN });
    assert.deepEqual([...p.data], [7, flag], action);
    assert.deepEqual(p.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [[GUARDIAN, true, false], [CONFIG_PDA, false, true]]);
  }
  assert.throws(() => guardianInstruction({ sv, web3, action: 'withdraw', guardian: GUARDIAN }), /unknown action/);
});

test('guardian: the connected wallet must be Config.guardian; each action has its on-chain precondition', () => {
  assert.equal(guardianProblem(GUARDIAN, GUARDIAN), null);
  assert.match(guardianProblem(OTHER, GUARDIAN), /is not the guardian 4wTV/);
  assert.match(guardianProblem(null, GUARDIAN), /connect the guardian/);
  assert.match(guardianProblem('not-an-address', GUARDIAN), /connect the guardian/);
  const pending = { owner: null, pending: { owner: new web3.PublicKey(CLAIMANT), unlockTs: 2_000n, inProbation: false } };
  assert.deepEqual(actionProblems({ action: 'cancel', config: {}, vaultState: pending, now: 1_999n }), []);
  assert.match(actionProblems({ action: 'cancel', config: {}, vaultState: pending, now: 2_000n })[0], /ClaimWindowElapsed/);
  assert.match(actionProblems({ action: 'cancel', config: {}, vaultState: { pending: null }, now: 1n })[0], /nothing pending/);
  assert.match(actionProblems({ action: 'cancel', config: {}, vaultState: null, now: 1n })[0], /no VaultState/);
  assert.deepEqual(actionProblems({ action: 'pause', config: { paused: false } }), []);
  assert.match(actionProblems({ action: 'pause', config: { paused: true } })[0], /already paused/);
  assert.deepEqual(actionProblems({ action: 'unpause', config: { paused: true } }), []);
  assert.match(actionProblems({ action: 'unpause', config: { paused: false } })[0], /not paused/);
});

test('guardian prepare: an unsigned transaction for the guardian (fee payer), simulated before the page sees it', async () => {
  const chain = fakeChain();
  const p = await prepare({ chain, sv, web3, action: 'cancel', placeId: PLACE, wallet: GUARDIAN });
  assert.equal(p.ok, true, JSON.stringify(p.problems));
  assert.equal(p.guardian, GUARDIAN);
  assert.equal(Buffer.from(chain.calls.placeHash).toString('hex'), placeHashHex(PLACE));
  assert.deepEqual(chain.calls.simulate, [p.transaction]);
  assert.ok(p.summary.some((l) => l.includes(`pending claimant ${CLAIMANT}`)), p.summary.join('\n'));
  const tx = web3.Transaction.from(Buffer.from(p.transaction, 'base64'));
  assert.equal(tx.feePayer.toBase58(), GUARDIAN);
  assert.equal(tx.recentBlockhash, BLOCKHASH);
  assert.deepEqual(tx.signatures.map((s) => [s.publicKey.toBase58(), s.signature]), [[GUARDIAN, null]], 'one empty slot: only the guardian signs');
  assert.equal(tx.instructions.length, 1);
  assert.deepEqual([...tx.instructions[0].data], [3]);
  assert.equal(p.message, b58encode(tx.serializeMessage()));
  // the page's own check of the bytes it is about to hand to Phantom
  const bytes = fromBase64(p.transaction);
  assert.equal(feePayerOf(bytes), GUARDIAN);
  assert.equal(signingProblem({ connected: GUARDIAN, guardian: GUARDIAN, transaction: bytes }), null);
  assert.match(signingProblem({ connected: OTHER, guardian: GUARDIAN, transaction: bytes }), /not the guardian/);
  assert.match(signingProblem({ connected: OTHER, guardian: OTHER, transaction: bytes }), /not for the guardian/);
  assert.match(signingProblem({ connected: null, guardian: GUARDIAN, transaction: bytes }), /connect Phantom/);

  const pause = await prepare({ chain: fakeChain(), sv, web3, action: 'pause', wallet: GUARDIAN });
  assert.equal(pause.ok, true);
  assert.deepEqual([...web3.Transaction.from(Buffer.from(pause.transaction, 'base64')).instructions[0].data], [7, 1]);
});

test('guardian prepare: refuses the wrong wallet, nothing pending, a closed window, a no-op pause, bad input', async () => {
  const refused = async (chain, req, re) => {
    const p = await prepare({ chain, sv, web3, ...req });
    assert.equal(p.ok, false, JSON.stringify(req));
    assert.equal(p.transaction, undefined);
    assert.ok(p.problems.some((x) => re.test(x)), `${JSON.stringify(req)} → ${p.problems.join(' | ')}`);
    assert.deepEqual(chain.calls?.simulate ?? [], [], 'nothing simulated');
  };
  await refused(fakeChain(), { action: 'cancel', placeId: PLACE, wallet: OTHER }, /is not the guardian/);
  await refused(fakeChain(), { action: 'cancel', placeId: PLACE, wallet: undefined }, /connect the guardian/);
  await refused(fakeChain({ pending: false }), { action: 'cancel', placeId: PLACE, wallet: GUARDIAN }, /nothing pending/);
  await refused(fakeChain({ vault: false }), { action: 'cancel', placeId: PLACE, wallet: GUARDIAN }, /no VaultState/);
  await refused(fakeChain({ now: 2_000n }), { action: 'cancel', placeId: PLACE, wallet: GUARDIAN }, /window has elapsed/);
  await refused(fakeChain({ paused: true }), { action: 'pause', wallet: GUARDIAN }, /already paused/);
  await refused(fakeChain(), { action: 'unpause', wallet: GUARDIAN }, /not paused/);
  await refused(fakeChain(), { action: 'cancel', placeId: "x'; DROP TABLE claims;--", wallet: GUARDIAN }, /place id/);
  await refused(fakeChain(), { action: 'withdraw', wallet: GUARDIAN }, /action must be/);
  const sim = await prepare({ chain: fakeChain({ simErr: { InstructionError: [0, { Custom: 124 }] } }), sv, web3, action: 'pause', wallet: GUARDIAN });
  assert.equal(sim.ok, false);
  assert.equal(sim.transaction, undefined);
  assert.match(sim.problems[0], /simulation failed: Unauthorized \(124\)/);
  // the guardian pays the fee: an empty guardian account (devnet's key file, a fresh Phantom account) says so plainly
  const empty = await prepare({ chain: fakeChain({ simErr: 'AccountNotFound' }), sv, web3, action: 'pause', wallet: GUARDIAN });
  assert.match(empty.problems[0], /AccountNotFound: the guardian wallet needs a little SOL for the fee/);
});

/** One request to the local server with a chosen Host header (fetch cannot set Host). */
function get(port, path, { host = `127.0.0.1:${port}`, method = 'GET', body, type } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host, ...(type ? { 'content-type': type } : {}) } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('guardian server: serves only the page files, answers only on its own host, never signs', async () => {
  const server = createGuardianServer({ cluster: 'mainnet', chain: fakeChain(), sv, web3, prefill: { action: 'cancel', placeId: PLACE } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const page = await get(port, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.text, /AtlasPad guardian/);
    assert.match(page.text, /src="\/guardian\/app\.mjs"/);
    for (const p of Object.keys(FILES)) assert.equal((await get(port, p)).status, 200, p);
    assert.match((await get(port, '/guardian/app.mjs')).headers['content-type'], /javascript/);
    for (const p of ['/scripts/guardian.mjs', '/../.env.server', '/.keys/mainnet-crank.json', '/lib/keys.mjs', '/guardian/index.html']) assert.equal((await get(port, p)).status, 404, p);
    assert.equal((await get(port, '/', { host: `evil.example:${port}` })).status, 421, 'DNS rebinding');
    assert.equal((await get(port, '/api/info', { host: 'localhost' })).status, 421, 'another port');
    assert.equal((await get(port, '/', { host: `localhost:${port}` })).status, 200);

    const info = (await get(port, '/api/info')).json();
    assert.deepEqual(info, { cluster: 'mainnet', chain: 'solana:mainnet', flavor: 'mainnet', guardian: GUARDIAN, guardianSol: 0.0025, paused: false, explorerTx: 'https://solscan.io/tx/{sig}', prefill: { action: 'cancel', placeId: PLACE } });

    const body = JSON.stringify({ action: 'cancel', placeId: PLACE, wallet: GUARDIAN });
    const p = await get(port, '/api/prepare', { method: 'POST', body, type: 'application/json' });
    assert.equal(p.status, 200);
    assert.equal(p.json().ok, true);
    assert.equal(p.headers['access-control-allow-origin'], undefined, 'same-origin only');
    assert.equal((await get(port, '/api/prepare', { method: 'POST', body, type: 'text/plain' })).status, 400);
    assert.equal((await get(port, '/api/prepare', { method: 'POST', body: 'x'.repeat(5_000), type: 'application/json' })).status, 400);

    const sig = b58encode(new Uint8Array(64).fill(7));
    assert.deepEqual((await get(port, `/api/status?sig=${sig}`)).json(), { status: 'confirmed' });
    assert.equal((await get(port, '/api/status?sig=nope')).status, 400);
  } finally {
    server.close();
  }
});

test('guardian page: Wallet Standard discovery, Phantom first, injected-provider fallback', async () => {
  const win = new EventTarget();
  win.CustomEvent = CustomEvent;
  const sent = [];
  const account = { address: GUARDIAN, chains: ['solana:mainnet', 'solana:devnet'] };
  const wallet = (name, extra = {}) => ({
    name,
    chains: ['solana:mainnet', 'solana:devnet'],
    accounts: [account],
    features: {
      'standard:connect': { connect: async () => ({ accounts: [account] }) },
      'solana:signAndSendTransaction': {
        signAndSendTransaction: async (input) => {
          sent.push(input);
          return [{ signature: new Uint8Array(64).fill(9) }];
        },
      },
      ...extra,
    },
  });
  // a wallet injected before the page (waits for app-ready) and one injected after it (announces itself)
  win.addEventListener('wallet-standard:app-ready', ({ detail }) => detail.register(wallet('Solflare')));
  const list = walletRegistry(win);
  win.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: ({ register }) => register(wallet('Phantom')) }));
  win.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: () => { throw new Error('broken wallet'); } }));
  assert.deepEqual(list().map((w) => w.name), ['Solflare', 'Phantom']);

  const choice = pickWallet(list(), win);
  assert.equal(choice.kind, 'standard');
  assert.equal(choice.name, 'Phantom');
  const c = await connectWallet(choice);
  assert.equal(c.address, GUARDIAN);
  const transaction = Uint8Array.of(1, 2, 3);
  const sig = await signAndSend(choice, { account: c.account, chain: 'solana:mainnet', transaction, message: 'unused' });
  assert.equal(sig, b58encode(new Uint8Array(64).fill(9)));
  assert.deepEqual(sent, [{ account, chain: 'solana:mainnet', transaction }]);

  // no Wallet Standard Phantom: the injected window.phantom.solana, through its documented request form
  const calls = [];
  const legacyWin = {
    phantom: {
      solana: {
        isPhantom: true,
        connect: async () => ({ publicKey: { toString: () => GUARDIAN } }),
        request: async (r) => {
          calls.push(r);
          return { signature: sig };
        },
      },
    },
  };
  const legacy = pickWallet([wallet('Solflare')], legacyWin);
  assert.equal(legacy.kind, 'legacy');
  assert.equal((await connectWallet(legacy)).address, GUARDIAN);
  assert.equal(await signAndSend(legacy, { chain: 'solana:mainnet', transaction, message: 'MSG58' }), sig);
  assert.deepEqual(calls, [{ method: 'signAndSendTransaction', params: { message: 'MSG58' } }]);
  // any other Solana wallet that can sign and send (the guardian check decides); none at all → null
  assert.equal(pickWallet([wallet('Solflare')], {}).name, 'Solflare');
  assert.equal(pickWallet([wallet('NoSend', { 'solana:signAndSendTransaction': undefined })], {}), null);
  assert.equal(pickWallet([], {}), null);
});

test('guardian page: the fee payer is read from the transaction bytes', () => {
  const ix = guardianInstruction({ sv, web3, action: 'pause', guardian: GUARDIAN });
  const { transaction } = unsignedTransaction({ web3, ix, feePayer: GUARDIAN, blockhash: BLOCKHASH });
  assert.equal(feePayerOf(Uint8Array.from(transaction)), GUARDIAN);
  const other = unsignedTransaction({ web3, ix, feePayer: OTHER, blockhash: BLOCKHASH });
  assert.equal(feePayerOf(Uint8Array.from(other.transaction)), OTHER, 'another fee payer adds a second signature slot');
});

test('guardian --lan: only external IPv4 addresses', () => {
  const ifaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.1.23', family: 'IPv4', internal: false },
    ],
    utun: [{ address: '10.8.0.2', family: 4, internal: false }],
  };
  assert.deepEqual(lanAddresses(ifaces), ['192.168.1.23', '10.8.0.2']);
});

test('guardian docs: the RUNBOOK section exists and the checklist guardian line points at it', () => {
  const runbook = readFileSync(join(ROOT, 'RUNBOOK.md'), 'utf8');
  assert.ok(runbook.includes('### Guardian: cancel a wrong claim / pause launches'));
  const section = runbook.slice(runbook.indexOf('### Guardian: cancel a wrong claim / pause launches'), runbook.indexOf('## 9. Moderation'));
  for (const s of ['node scripts/guardian.mjs --cluster mainnet --lan cancel <placeId>', 'Phantom → **Browser**', '✓ this is the guardian', 'Import Private Key', '--cluster devnet --lan']) assert.ok(section.includes(s), s);
  const checklist = readFileSync(join(ROOT, 'MAINNET-CHECKLIST.md'), 'utf8');
  const guardianLine = checklist.slice(checklist.indexOf('The **guardian** is a wallet'), checklist.indexOf('**Squads multisig A**'));
  assert.match(guardianLine, /node scripts\/guardian\.mjs/);
  assert.match(guardianLine, /RUNBOOK §8 "Guardian: cancel a wrong claim \/ pause\s+launches"/);
});
