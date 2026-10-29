#!/usr/bin/env node
/**
 * Guardian signing page (SPEC §5.4 cancel_claim, set_paused; RUNBOOK §8 "Guardian: cancel a wrong claim / pause
 * launches"). The mainnet guardian is a Phantom account on the owner's phone, and nothing on this machine signs for it
 * (claims-admin.mjs only prints an unsigned transaction). This serves a small local page (scripts/guardian/) that:
 *   1. connects Phantom (Wallet Standard; window.phantom.solana as a fallback) and checks that the account IS
 *      Config.guardian, read on chain;
 *   2. builds cancel_claim(<placeId>) or set_paused(1 | 0) with the shop-vault client builders (as claims-admin.mjs),
 *      guardian = authority and fee payer, a fresh blockhash, and simulates it (no signature needed). A cancel with
 *      nothing pending or past its unlock time, a pause while paused and an unpause while running are refused;
 *   3. asks Phantom to sign and send it, then shows the signature and its confirmation.
 * It holds no key and sends nothing itself. RPC: RPC_URL when set (never given to the page), else the public endpoint.
 *
 *   node scripts/guardian.mjs --cluster mainnet                    http://127.0.0.1:8790 (this laptop's browser only)
 *   node scripts/guardian.mjs --cluster mainnet --lan              also on this laptop's Wi-Fi address, for Phantom's
 *                                                                  in-app browser on the phone (your own Wi-Fi only)
 *   node scripts/guardian.mjs --cluster mainnet cancel <placeId>   prefills the form (or: pause, unpause)
 *   options: --port <n> (8790)
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { b58decode, b58encode, isAddress } from './lib/b58.mjs';
import { fatal, head, info, ok, parseArgs, redact, warn } from './lib/log.mjs';
import { CONFIG_PDA, explorerTx, ROOT } from './lib/paths.mjs';
import { assertGenesis, chainTime, getAccount, getBalance, label, rpc, rpcUrl } from './lib/rpc.mjs';
import { PLACE_ID_RE } from './moderate.mjs';

export const ACTIONS = ['cancel', 'pause', 'unpause'];
export const DEFAULT_PORT = 8790;

/** Everything the page loads, by URL path (nothing else on disk is served). */
export const FILES = {
  '/': ['scripts/guardian/index.html', 'text/html; charset=utf-8'],
  '/guardian/app.mjs': ['scripts/guardian/app.mjs', 'text/javascript; charset=utf-8'],
  '/lib/b58.mjs': ['scripts/lib/b58.mjs', 'text/javascript; charset=utf-8'],
};

/** null when `wallet` is the on-chain guardian, else what to do. */
export function guardianProblem(wallet, guardian) {
  if (!wallet || !isAddress(wallet)) return 'connect the guardian wallet in Phantom first';
  if (wallet !== guardian) return `the connected wallet ${wallet} is not the guardian ${guardian} (Config, on chain): switch to the guardian account in Phantom and connect again`;
  return null;
}

/** What stops `action` now, from the decoded Config / VaultState and the chain clock (unix seconds, bigint). */
export function actionProblems({ action, config, vaultState, now }) {
  if (action === 'pause') return config.paused ? ['launches are already paused'] : [];
  if (action === 'unpause') return config.paused ? [] : ['launches are not paused'];
  if (!vaultState) return ['no AtlasPad coin for this place on this cluster (no VaultState)'];
  if (!vaultState.pending) return ['nothing pending on chain for this place'];
  if (now >= vaultState.pending.unlockTs) return ['the claim window has elapsed: cancel_claim would fail (ClaimWindowElapsed, 123)'];
  return [];
}

/** The review lines the page shows before anything is signed. */
export function actionSummary({ action, config, vaultState, now, placeId }) {
  if (action === 'pause') return [`launches are ${config.paused ? 'PAUSED' : 'running'}`, 'set_paused(1) stops NEW launches only: trading, claims and withdrawals keep working'];
  if (action === 'unpause') return [`launches are ${config.paused ? 'PAUSED' : 'running'}`, 'set_paused(0) lets launches start again'];
  const out = [`place ${placeId}`];
  if (!vaultState) return out;
  out.push(`current owner ${vaultState.owner ? vaultState.owner.toBase58() : 'none yet'}`);
  const p = vaultState.pending;
  if (p) {
    const left = Number(p.unlockTs - now);
    out.push(`pending claimant ${p.owner.toBase58()} · unlocks ${new Date(Number(p.unlockTs) * 1000).toISOString()} (${(left / 3600).toFixed(1)} h left)${p.inProbation ? ' · requested during a probation' : ''}`);
    out.push('cancel_claim drops this claim; the claimant has to verify again');
  }
  return out;
}

/** The guardian's instruction, from the shop-vault client builders. */
export function guardianInstruction({ sv, web3, action, placeId, guardian }) {
  const authority = new web3.PublicKey(guardian);
  if (action === 'cancel') return sv.cancelClaim({ authority, placeHash: sv.placeHash(placeId) });
  if (action === 'pause' || action === 'unpause') return sv.setPaused({ authority, paused: action === 'pause' });
  throw new Error(`unknown action ${action}`);
}

/** Unsigned legacy transaction (fee payer = `feePayer`): the wire bytes with one empty signature, and the message. */
export function unsignedTransaction({ web3, ix, feePayer, blockhash }) {
  const tx = new web3.Transaction();
  tx.feePayer = new web3.PublicKey(feePayer);
  tx.recentBlockhash = blockhash;
  tx.add(ix);
  return { transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }), message: tx.serializeMessage() };
}

/**
 * POST /api/prepare: re-reads Config (and the place's VaultState), checks the wallet and the action, then builds and
 * simulates the transaction. `chain` reads the cluster (rpcChain; a fake in tests). Never signs.
 */
export async function prepare({ chain, sv, web3, action, placeId, wallet }) {
  if (!ACTIONS.includes(action)) return { ok: false, problems: [`action must be one of ${ACTIONS.join(', ')}`] };
  if (action === 'cancel' && !(typeof placeId === 'string' && PLACE_ID_RE.test(placeId))) return { ok: false, problems: ['enter the Google place id of the claim (claims-admin list and the claim alert show it)'] };
  const config = await chain.config();
  const guardian = config.guardian.toBase58();
  const vaultState = action === 'cancel' ? await chain.vaultState(sv.placeHash(placeId)) : null;
  const now = await chain.now();
  const summary = actionSummary({ action, config, vaultState, now, placeId });
  const problems = [guardianProblem(wallet, guardian), ...actionProblems({ action, config, vaultState, now })].filter(Boolean);
  if (problems.length) return { ok: false, guardian, summary, problems };
  const { blockhash, lastValidBlockHeight } = await chain.blockhash();
  const { transaction, message } = unsignedTransaction({ web3, ix: guardianInstruction({ sv, web3, action, placeId, guardian }), feePayer: guardian, blockhash });
  const sim = await chain.simulate(Buffer.from(transaction).toString('base64'));
  if (sim.err) {
    const e = sv.parseShopVaultError(sim.err);
    // the guardian pays the fee (5,000 lamports): an empty account does not exist on chain
    const why = e?.name ? `${e.name} (${e.code})` : ['AccountNotFound', 'InsufficientFundsForFee'].includes(sim.err) ? `${sim.err}: the guardian wallet needs a little SOL for the fee; send it 0.01 SOL first` : JSON.stringify(sim.err);
    return { ok: false, guardian, summary, problems: [`simulation failed: ${why}`], logs: (sim.logs ?? []).slice(-8) };
  }
  return { ok: true, guardian, summary, transaction: Buffer.from(transaction).toString('base64'), message: b58encode(message), lastValidBlockHeight };
}

/** GET /api/info: the cluster, the on-chain guardian (and its SOL for fees), the pause flag and the CLI prefill. */
export async function pageInfo({ cluster, chain, prefill = {} }) {
  const config = await chain.config();
  const guardian = config.guardian.toBase58();
  const guardianSol = Number(await chain.balance(guardian)) / 1e9;
  return { cluster, chain: `solana:${cluster}`, flavor: config.flavor, guardian, guardianSol, paused: config.paused, explorerTx: explorerTx('{sig}', cluster), prefill };
}

/** GET /api/status?sig=: pending | processed | confirmed | finalized | failed. */
export async function txStatus(chain, sig) {
  const s = await chain.status(sig);
  if (!s) return { status: 'pending' };
  if (s.err) return { status: 'failed', err: s.err };
  return { status: s.confirmationStatus ?? 'processed' };
}

/** The chain reads the page needs, over JSON-RPC (lib/rpc.mjs: retries, URL never printed). */
export function rpcChain(url, sv) {
  return {
    async config() {
      const acc = await getAccount(url, CONFIG_PDA);
      if (!acc) throw new Error('Config is not initialised on this cluster');
      return sv.decodeConfig(acc.data);
    },
    async vaultState(placeHash) {
      const acc = await getAccount(url, sv.vaultStatePda(placeHash)[0].toBase58());
      return acc ? sv.decodeVaultState(acc.data) : null;
    },
    now: () => chainTime(url),
    balance: (address) => getBalance(url, address),
    blockhash: async () => (await rpc(url, 'getLatestBlockhash', [{ commitment: 'confirmed' }])).value,
    simulate: async (b64) => (await rpc(url, 'simulateTransaction', [b64, { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }])).value,
    status: async (sig) => (await rpc(url, 'getSignatureStatuses', [[sig]])).value[0],
  };
}

async function readJson(req) {
  if (!/^application\/json/.test(req.headers['content-type'] ?? '')) return null;
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 4_096) return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The page's HTTP server. Answers only on 127.0.0.1 / localhost (and `lanHosts` with --lan) at its own port, so a web
 * page that rebinds its DNS to this machine gets 421; the API is same-origin (no CORS headers) and reads public chain
 * data only.
 */
export function createGuardianServer({ cluster, chain, sv, web3, prefill = {}, lanHosts = [] }) {
  const server = createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      const port = server.address().port;
      if (!['127.0.0.1', 'localhost', ...lanHosts].some((h) => req.headers.host === `${h}:${port}`)) return send(421, { error: 'wrong_host' });
      const url = new URL(req.url ?? '/', 'http://guardian.invalid');
      const file = FILES[url.pathname];
      if (file && req.method === 'GET') return send(200, readFileSync(join(ROOT, file[0])), file[1]);
      if (url.pathname === '/api/info' && req.method === 'GET') return send(200, await pageInfo({ cluster, chain, prefill }));
      if (url.pathname === '/api/prepare' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body) return send(400, { error: 'bad_request', message: 'JSON body { action, placeId?, wallet } expected' });
        return send(200, await prepare({ chain, sv, web3, action: body.action, placeId: body.placeId, wallet: body.wallet }));
      }
      if (url.pathname === '/api/status' && req.method === 'GET') {
        const sig = url.searchParams.get('sig') ?? '';
        let valid = false;
        try {
          valid = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig) && b58decode(sig).length === 64;
        } catch {
          /* not base58 */
        }
        if (!valid) return send(400, { error: 'bad_request', message: 'sig must be a transaction signature' });
        return send(200, await txStatus(chain, sig));
      }
      return send(404, { error: 'not_found' });
    } catch (e) {
      return send(502, { error: 'upstream', message: redact(e?.message ?? String(e)) });
    }
  });
  return server;
}

/** This machine's IPv4 addresses on its Wi-Fi / LAN interfaces (for --lan). */
export function lanAddresses(ifaces = networkInterfaces()) {
  return Object.values(ifaces)
    .flat()
    .filter((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal)
    .map((a) => a.address);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['lan']);
  const cluster = args.cluster;
  const [action, placeId] = args._;
  const port = Number(args.port ?? DEFAULT_PORT);
  if (!['devnet', 'mainnet'].includes(cluster) || (action && !ACTIONS.includes(action)) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    console.error('usage: node scripts/guardian.mjs --cluster devnet|mainnet [cancel <placeId> | pause | unpause] [--lan] [--port 8790]');
    process.exit(64);
  }
  if (action === 'cancel' && !PLACE_ID_RE.test(placeId ?? '')) fatal('cancel needs a Google place id (node scripts/claims-admin.mjs --env <cluster> list shows them)', 64);
  const url = rpcUrl(cluster);
  head(`guardian page · ${cluster} · ${label(url)}`);
  await assertGenesis(url, cluster);
  const { sv, web3 } = await import('./lib/web3.mjs');
  const chain = rpcChain(url, sv);
  const cfg = await chain.config();
  if (cfg.flavor !== cluster) fatal(`Config flavor is ${cfg.flavor}, not ${cluster}: stop (SPEC T18)`);
  info(`Config.guardian ${cfg.guardian.toBase58()} · launches ${cfg.paused ? 'PAUSED' : 'running'}`);
  const lan = args.lan ? lanAddresses() : [];
  const server = createGuardianServer({ cluster, chain, sv, web3, prefill: { action: action ?? null, placeId: placeId ?? null }, lanHosts: lan });
  server.on('error', (e) => fatal(e.code === 'EADDRINUSE' ? `port ${port} is in use: pass --port <another>` : e.message));
  server.listen(port, args.lan ? '0.0.0.0' : '127.0.0.1', () => {
    ok(`laptop: open http://127.0.0.1:${port}/ in the browser that has the guardian's Phantom extension`);
    for (const ip of lan) ok(`phone on the same Wi-Fi: Phantom → Browser (globe icon) → http://${ip}:${port}/`);
    if (args.lan && !lan.length) warn('no Wi-Fi/LAN address found: is this laptop on a network?');
    info('Ctrl+C stops it. Nothing is signed or sent from this machine: Phantom shows the transaction and sends it.');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fatal(e.message));
}
