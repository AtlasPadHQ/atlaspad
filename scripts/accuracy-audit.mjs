#!/usr/bin/env node
/**
 * Accuracy audit (INTEGRATION §9): re-derives every number the app shows for N coins straight from the chain (public
 * RPC from this machine) and compares it with what the Worker serves. Read-only. Exit 1 outside tolerance.
 *
 *   node scripts/accuracy-audit.mjs https://cornershop-devnet.tiejiucai.workers.dev [--cluster devnet] [--n 20]
 *   options: --mints a,b,c · --json · --no-volume (skip the 24 h volume re-count) · --max-sigs 300
 *
 * Per coin
 *  - market (/api/market): vSol, vTok, realSol, realTok, supply EXACT; mcap EXACT (vQuote × supply / vToken);
 *    price with 15 fractional digits (same bigint maths as src/chain/curve.ts); progress to 2 decimals; complete flag.
 *    Graduated: pool price from vault balances (+ virtual quote) within ±0.1%.
 *  - fees (/api/coins/:mint?fresh=1): waiting == feesWaiting(vault, state, pump creator vault, curve bucket, vault WSOL)
 *    EXACT (never over), withdrawn == VaultState.total_withdrawn, earned == withdrawn + waiting.
 *  - owner: owner / pending owner / unlock_ts / probation flag == VaultState.
 *  - volume 24 h == Σ TradeEvent.sol_amount over 24 h from getSignaturesForAddress(curve) (differences only from
 *    trades in the indexer-lag window (2 min) or within 60 s of the 24 h boundary are tolerated, as warnings);
 *    every on-chain trade older than 2 min among the latest 50 is in detail.trades.
 * Global: SOL/USD within ±0.5% of Pyth Hermes and ≤ 120 s old.
 * The chain is read before and after the API; when the state moved in between, the coin is re-read (up to 3 times).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCurve, curveNumbers, decodeEvents, poolNumbers, tokenAmount } from './lib/events.mjs';
import { Checks, fatal, head, info, parseArgs, sleep } from './lib/log.mjs';
import { GENESIS, OUT_DIR } from './lib/paths.mjs';
import { assertGenesis, getMultipleAccounts, rentExempt, rpc, rpcUrl } from './lib/rpc.mjs';

const PYTH_SOL_USD = '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

export const TOL = { priceRel: 1e-9, progressAbs: 0.01, poolRel: 0.001, solUsdRel: 0.005, solUsdAgeSec: 120, lagMs: 120_000, boundaryMs: 60_000 };
/** Devnet's cron runs every 5 minutes (wrangler.jsonc), so its cron-written figures can be up to one period older. */
export const tolFor = (cluster) => (cluster === 'devnet' ? { ...TOL, solUsdAgeSec: 330, lagMs: 330_000, boundaryMs: 330_000 } : TOL);

export function relDiff(a, b) {
  if (a === b) return 0;
  const d = Math.abs(a - b);
  return d / Math.max(Math.abs(a), Math.abs(b), Number.EPSILON);
}

async function getJson(origin, path) {
  let r;
  for (let attempt = 0; ; attempt++) {
    r = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(20_000) });
    if (r.status !== 429 || attempt >= 4) break;
    await sleep(Math.min(60, Number(r.headers.get('retry-after') ?? '5')) * 1000 + 250); // RL_FRESH is 30/min
  }
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: r.status, json };
}

/** All chain accounts that feed one coin's numbers. */
async function readCoinChain(url, coin, sv, web3) {
  const vault = new web3.PublicKey(coin.vault);
  const keys = [coin.bondingCurve, coin.vault, coin.vaultState, sv.pumpCreatorVaultPda(vault).toBase58(), sv.vaultWsolAta(vault).toBase58()];
  const accs = await getMultipleAccounts(url, keys);
  return { slot: accs.slot, curve: accs[0], vault: accs[1], state: accs[2], creatorVault: accs[3], wsol: accs[4] };
}

function sameChain(a, b) {
  const l = (x) => (x ? `${x.lamports}:${x.data.toString('base64')}` : '-');
  return ['curve', 'vault', 'state', 'creatorVault', 'wsol'].every((k) => l(a[k]) === l(b[k]));
}

export async function audit({ origin, cluster, n = 20, mints, volume = true, maxSigs = 300 }) {
  const checks = new Checks();
  const url = rpcUrl(cluster); // RPC_URL when set (the public endpoint rate-limits a full audit), else the public one
  await assertGenesis(url, cluster);
  const { sv, web3 } = await import('./lib/web3.mjs');
  const report = { origin, cluster, at: new Date().toISOString(), coins: [] };
  const tol = tolFor(cluster);

  const cfg = (await getJson(origin, '/api/config')).json;
  if (!cfg || cfg.cluster !== cluster) throw new Error(`/api/config cluster is ${cfg?.cluster}, expected ${cluster}`);
  if (cfg.genesisHash !== GENESIS[cluster]) throw new Error('Worker genesis mismatch');
  const initReal = BigInt(cfg.curve?.initialRealTokenReserves ?? '793100000000000');

  // --------------------------------------------------------------------------------------------- SOL/USD
  head('SOL/USD');
  // Reference: Pyth Hermes; the public endpoint now answers 401 without a key, so Coinbase spot is the fallback.
  const refPrice = async () => {
    try {
      const p = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_SOL_USD}&parsed=true`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
      const pp = p.parsed?.[0]?.price;
      const v = Number(pp.price) * 10 ** Number(pp.expo);
      if (Number.isFinite(v) && v > 0) return { src: 'Pyth', v };
    } catch {
      /* fall through */
    }
    const c = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
    const v = Number(c?.data?.amount);
    if (Number.isFinite(v) && v > 0) return { src: 'Coinbase', v };
    throw new Error('no reference price');
  };
  try {
    const ref = await refPrice();
    const age = cfg.solUsdAt ? (Date.now() - cfg.solUsdAt) / 1000 : Infinity;
    report.solUsd = { worker: cfg.solUsd, reference: ref.v, referenceSrc: ref.src, ageSec: Math.round(age) };
    if (cfg.solUsd == null) checks.fail('SOL/USD', 'Worker serves null');
    else {
      checks.check(relDiff(cfg.solUsd, ref.v) <= tol.solUsdRel, `SOL/USD within ±0.5% of ${ref.src}`, `$${cfg.solUsd} vs $${ref.v.toFixed(4)}`);
      checks.check(age <= tol.solUsdAgeSec, `SOL/USD fresh (≤ ${tol.solUsdAgeSec} s)`, `${Math.round(age)} s`);
    }
  } catch (e) {
    checks.warn('SOL/USD', `no reference price from here (${e.message})`);
  }

  // --------------------------------------------------------------------------------------------- coins
  let list;
  if (mints?.length) list = (await getJson(origin, `/api/coins?mints=${mints.join(',')}`)).json?.coins ?? [];
  else list = (await getJson(origin, `/api/coins?sort=new&limit=${n}`)).json?.coins ?? [];
  if (!list.length) checks.warn('coins', 'registry is empty; nothing to audit');
  const rent0 = await rentExempt(url, 0);
  const rentState = await rentExempt(url, sv.VAULT_STATE_LEN);

  for (const coin of list) {
    head(`$${coin.ticker} ${coin.mint}`);
    const row = { mint: coin.mint, ticker: coin.ticker, problems: [] };
    report.coins.push(row);
    let attempt = 0;
    let done = false;
    while (!done && attempt++ < 3) {
      const before = await readCoinChain(url, coin, sv, web3);
      const market = (await getJson(origin, `/api/market?mints=${coin.mint}`)).json?.quotes?.[coin.mint];
      const detail = (await getJson(origin, `/api/coins/${coin.mint}?fresh=1`)).json;
      const after = await readCoinChain(url, coin, sv, web3);
      if (!sameChain(before, after)) {
        info(`state moved during the read (slot ${before.slot} → ${after.slot}); re-reading`);
        await sleep(2500);
        continue;
      }
      done = true;
      const ch = after;
      if (!market || !detail?.market) {
        checks.fail(`$${coin.ticker} API`, 'market or detail missing');
        break;
      }
      // ---- market
      if (!coin.graduated && ch.curve) {
        const c = decodeCurve(ch.curve.data);
        const num = curveNumbers(c, initReal);
        const exact = { vSol: c.vSol, vTok: c.vTok, realSol: c.realSol, realTok: c.realTok, supply: c.supply, mcapLamports: num.mcapLamports };
        for (const [k, v] of Object.entries(exact)) {
          const got = market[k];
          if (got === v.toString()) checks.pass(`$${coin.ticker} market.${k}`, got);
          else if (market.slot < before.slot) checks.warn(`$${coin.ticker} market.${k}`, `${got} vs chain ${v} (market cache from slot ${market.slot} < ${before.slot}; ≤ 2 s cache)`);
          else checks.fail(`$${coin.ticker} market.${k}`, `${got} ≠ chain ${v}`);
        }
        checks.check(relDiff(market.priceLamports, num.priceLamports) <= tol.priceRel, `$${coin.ticker} price (exact)`, `${market.priceLamports} vs ${num.priceLamports} lamports/token`);
        checks.check(Math.abs(market.progressPct - num.progressPct) <= tol.progressAbs, `$${coin.ticker} progress`, `${market.progressPct}% vs ${num.progressPct}%`);
        checks.check(market.complete === c.complete, `$${coin.ticker} complete flag`, String(c.complete));
        checks.check(c.creator === coin.vault, `$${coin.ticker} curve.creator = vault (no admin_cto)`, c.creator);
      } else if (coin.graduated && coin.pool) {
        const poolAcc = (await getMultipleAccounts(url, [coin.pool]))[0];
        if (!poolAcc) checks.fail(`$${coin.ticker} pool`, 'pool account missing');
        else {
          const base = poolAcc.data.subarray(139, 171);
          const quote = poolAcc.data.subarray(171, 203);
          const { b58encode } = await import('./lib/b58.mjs');
          const [bv, qv] = await getMultipleAccounts(url, [b58encode(base), b58encode(quote)]);
          const pn = poolNumbers(tokenAmount(bv.data) ?? 0n, tokenAmount(qv.data) ?? 0n);
          checks.check(relDiff(market.priceLamports, pn.priceLamports) <= tol.poolRel, `$${coin.ticker} pool price within ±0.1%`, `${market.priceLamports} vs ${pn.priceLamports} (virtual quote not included here)`);
        }
      }
      // ---- fees + owner
      if (ch.state) {
        const st = sv.decodeVaultState(ch.state.data);
        const bucket = ch.curve ? decodeCurve(ch.curve.data).creatorFeeBucket : 0n;
        const fw = sv.feesWaiting({
          vaultLamports: ch.vault?.lamports ?? 0n,
          vaultStateLamports: ch.state.lamports,
          rentMin0: rent0,
          rentMinVaultState: rentState,
          pumpCreatorVaultLamports: ch.creatorVault?.lamports ?? 0n,
          curveCreatorFeeBucket: coin.graduated ? 0n : bucket,
          wsolLamports: ch.wsol?.lamports ?? 0n,
        });
        const f = detail.fees;
        if (coin.graduated) {
          const w = BigInt(f.waitingLamports);
          checks.check(w >= fw.total, `$${coin.ticker} fees.waiting ≥ vault-side total (AMM creator vault adds to it)`, `${f.waitingLamports} vs ${fw.total}`);
        } else checks.check(f.waitingLamports === fw.total.toString(), `$${coin.ticker} fees.waiting exact`, `${f.waitingLamports} vs chain ${fw.total}`);
        checks.check(f.withdrawnLamports === st.totalWithdrawn.toString(), `$${coin.ticker} fees.withdrawn = total_withdrawn`, f.withdrawnLamports);
        checks.check(BigInt(f.earnedLamports) === BigInt(f.withdrawnLamports) + BigInt(f.waitingLamports), `$${coin.ticker} earned = withdrawn + waiting`);
        const o = detail.owner;
        checks.check((o.owner ?? null) === (st.owner?.toBase58() ?? null), `$${coin.ticker} owner`, o.owner ?? 'none');
        checks.check((o.pendingOwner ?? null) === (st.pending?.owner.toBase58() ?? null), `$${coin.ticker} pending owner`, o.pendingOwner ?? 'none');
        checks.check((o.unlockTs ?? null) === (st.pending ? Number(st.pending.unlockTs) : null), `$${coin.ticker} unlock_ts`, String(o.unlockTs));
        checks.check(!!o.inProbation === !!st.pending?.inProbation, `$${coin.ticker} probation flag`);
        const want = st.pending ? 'pending' : st.owner ? 'claimed' : 'unclaimed';
        checks.check(o.status === want, `$${coin.ticker} owner.status`, o.status);
      } else checks.fail(`$${coin.ticker} VaultState`, 'missing on chain');

      // ---- volume + completeness
      if (volume) {
        const now = Date.now();
        const from = now - 86_400_000;
        let before;
        const sigs = [];
        while (sigs.length < maxSigs) {
          const page = await rpc(url, 'getSignaturesForAddress', [coin.bondingCurve, { limit: 100, ...(before ? { before } : {}), commitment: 'confirmed' }]);
          if (!page.length) break;
          sigs.push(...page);
          before = page[page.length - 1].signature;
          if ((page[page.length - 1].blockTime ?? 0) * 1000 < from - tol.boundaryMs) break;
        }
        const inWindow = sigs.filter((s) => !s.err && (s.blockTime ?? 0) * 1000 >= from - tol.boundaryMs);
        if (sigs.length >= maxSigs && (sigs[sigs.length - 1].blockTime ?? 0) * 1000 >= from) checks.warn(`$${coin.ticker} volume`, `more than ${maxSigs} signatures in 24 h; skipped (raise --max-sigs)`);
        else {
          const trades = [];
          for (const s of inWindow) {
            const tx = await rpc(url, 'getTransaction', [s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'json' }]);
            for (const e of decodeEvents(tx?.meta)) if (e.kind === 'trade' && e.mint === coin.mint) trades.push({ ...e, sig: s.signature, ts: e.ts || (tx.blockTime ?? 0) * 1000 });
          }
          const sum = (xs) => xs.reduce((a, t) => a + t.sol, 0n);
          const exact = sum(trades.filter((t) => t.ts >= from));
          const tolerated = sum(trades.filter((t) => Math.abs(t.ts - from) <= tol.boundaryMs || t.ts >= now - tol.lagMs));
          const api = BigInt(market.vol24hLamports);
          const diff = api > exact ? api - exact : exact - api;
          if (diff === 0n) checks.pass(`$${coin.ticker} volume 24 h exact`, `${api} lamports over ${trades.length} trade(s)`);
          else if (diff <= tolerated) checks.warn(`$${coin.ticker} volume 24 h`, `${api} vs ${exact}: difference ${diff} within the lag/boundary window`);
          else checks.fail(`$${coin.ticker} volume 24 h`, `${api} vs chain ${exact} (diff ${diff})`);
          const settled = trades.filter((t) => t.ts < now - tol.lagMs).sort((a, b) => b.ts - a.ts).slice(0, 50);
          const have = new Set((detail.trades ?? []).map((t) => t.sig));
          const missing = settled.filter((t) => !have.has(t.sig));
          const expectAll = settled.length <= (detail.trades?.length ?? 0) || (detail.trades?.length ?? 0) < 50;
          if (expectAll) checks.check(!missing.length, `$${coin.ticker} trades indexed`, missing.length ? `${missing.length} missing, e.g. ${missing[0].sig}` : `${settled.length} settled trade(s) present`);
        }
      }
    }
    if (!done) checks.warn(`$${coin.ticker}`, 'state kept moving; not audited (busy coin)');
  }
  report.checks = checks.toJSON();
  return { checks, report };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['json', 'no-volume']);
  const origin = args._[0];
  const cluster = args.cluster ?? (/cornershop-devnet/.test(origin ?? '') ? 'devnet' : 'mainnet');
  if (!origin || !['devnet', 'mainnet'].includes(cluster)) {
    console.error('usage: node scripts/accuracy-audit.mjs <origin> [--cluster devnet|mainnet] [--n 20] [--mints a,b] [--json] [--no-volume]');
    process.exit(64);
  }
  head(`accuracy-audit · ${origin} · ${cluster}`);
  const { checks, report } = await audit({
    origin: new URL(origin).origin,
    cluster,
    n: Number(args.n ?? 20),
    mints: typeof args.mints === 'string' ? args.mints.split(',') : undefined,
    volume: !args['no-volume'],
    maxSigs: Number(args['max-sigs'] ?? 300),
  });
  const green = checks.summary('accuracy-audit');
  if (args.json) {
    mkdirSync(OUT_DIR, { recursive: true });
    const p = join(OUT_DIR, `accuracy-audit-${cluster}-${report.at.replace(/[-:]/g, '').slice(0, 15)}.json`);
    writeFileSync(p, JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    info(`report: ${p}`);
  }
  process.exit(green ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fatal(e.message));
}
