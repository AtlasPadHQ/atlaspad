/**
 * `GET /api/config` (ConfigResponse, max-age=30), `GET /api/health` (HealthResponse, never a secret value) and
 * `POST /api/index/tx`.
 */
import { attestorPubkey } from './attestor';
import { isSignature } from './bytes';
import { altProblems, decodeAlt, decodeConfig } from './chainState';
import { CONFIG_PDA, GENESIS } from './consts';
import { cronPeriodMs, limit, type Ctx } from './ctx';
import { hasSecret, manualReviewEnabled, programIdOf } from './env';
import { verifyPlaceIdOnly } from './google';
import { ApiErr, CACHE, json, readJsonObject } from './http';
import { indexTx } from './indexer';
import { configView, freshSolUsd, globalFrom, metaSnapshot, SOL_USD_MAX_AGE_MS } from './meta';
import { phoneMode, twilioConfigured, twilioPartlyConfigured } from './phone';
import { TwilioVerifier } from './twilio';
import { turnstileEnabled } from './turnstile';
import type { ConfigResponse, HealthCheck, HealthResponse, IndexTxResponse } from './wire';

/**
 * The Worker faucet pays out only above this balance: 0.05 SOL fee reserve + the 0.25 SOL minimum payout
 * (worker/dev/airdrop.ts FAUCET_FLOOR; below it the airdrop refuses with 503 faucet_empty).
 */
export const FAUCET_PAYOUT_FLOOR_LAMPORTS = 300_000_000;

const faucetCache = new Map<string, { at: number; v: number | null }>();

/**
 * Devnet: the Devnet Test Wallet is a local keypair, so it is offered whenever this is a devnet build with dev
 * endpoints, whatever the faucet holds (a funded test wallet must never disappear because the faucet ran low). Only
 * the airdrop depends on the faucet: see `faucetCanPay`.
 */
function testWalletEnabled(ctx: Ctx): boolean {
  if (ctx.cluster !== 'devnet') return false;
  if (__CS_DEV_ENDPOINTS__) return true;
  return false;
}

/** Devnet only: the faucet's balance (kv_meta from the cron / the last airdrop, else one cached RPC read). */
async function faucetLamports(ctx: Ctx, cachedLamports: number | null): Promise<number | null> {
  if (ctx.cluster !== 'devnet') return null;
  if (__CS_DEV_ENDPOINTS__) {
    if (cachedLamports !== null) return cachedLamports;
    const hit = faucetCache.get(ctx.cluster);
    const now = ctx.deps.now();
    if (hit && now - hit.at < 60_000) return hit.v;
    let lamports: number | null = null;
    try {
      const m = await import('./dev/airdrop');
      const b = await m.faucetBalance(ctx, ctx.rpc(3));
      lamports = b === null ? null : Number(b);
    } catch {
      lamports = null;
    }
    faucetCache.set(ctx.cluster, { at: now, v: lamports });
    return lamports;
  }
  return null;
}

/** Devnet only: can `/api/dev/airdrop` pay out right now? */
function faucetCanPay(lamports: number | null): boolean {
  return lamports !== null && lamports >= FAUCET_PAYOUT_FLOOR_LAMPORTS;
}

export function explorerTemplates(cluster: 'devnet' | 'mainnet'): ConfigResponse['explorer'] {
  const q = cluster === 'devnet' ? '?cluster=devnet' : '';
  return { tx: `https://solscan.io/tx/{sig}${q}`, address: `https://solscan.io/account/{address}${q}`, token: `https://solscan.io/token/{mint}${q}` };
}

export async function handleConfig(ctx: Ctx): Promise<Response> {
  await limit(ctx.env.RL_READ, `read:${ctx.ipHash}`);
  const now = ctx.deps.now();
  const snap = await metaSnapshot(ctx);
  const [cfg, attestor] = await Promise.all([configView(ctx).catch(() => null), attestorPubkey(ctx.env)]);
  const g = globalFrom(snap, ctx.cluster);
  const solUsd = freshSolUsd(snap, now);
  const out: ConfigResponse = {
    cluster: ctx.cluster,
    genesisHash: GENESIS[ctx.cluster],
    publicOrigin: ctx.origin,
    programId: programIdOf(ctx.env),
    configPda: CONFIG_PDA,
    alt: ctx.env.ALT_ADDRESS?.trim() ?? '',
    attestor: attestor ?? cfg?.attestor ?? '',
    claimWindowSecs: cfg?.claimWindowSecs ?? 0,
    launchesPaused: cfg ? cfg.paused || cfg.attestor !== attestor : true,
    probationUntil: cfg?.probationUntil ?? 0,
    maxDevBuyLamports: (ctx.env.MAX_DEV_BUY_LAMPORTS ?? '1000000000').trim() || '1000000000',
    priorityFeeMicroLamports: snap.priorityFee ?? (Number(ctx.env.PRIORITY_FEE_DEFAULT ?? '10000') || 10_000),
    curve: {
      initialVirtualTokenReserves: g.initialVirtualTokenReserves.toString(),
      initialVirtualQuoteReserves: g.initialVirtualQuoteReserves.toString(),
      initialRealTokenReserves: g.initialRealTokenReserves.toString(),
      tokenTotalSupply: g.tokenTotalSupply.toString(),
    },
    solUsd,
    solUsdAt: solUsd !== null ? (snap.solUsd?.at ?? null) : null,
    features: {
      testWallet: testWalletEnabled(ctx),
      faucet: ctx.cluster === 'devnet' && faucetCanPay(await faucetLamports(ctx, snap.faucetLamports)),
      privy: hasSecret(ctx.env.PRIVY_APP_ID),
      phoneVerification: phoneMode(ctx.env, ctx.cluster),
      turnstileSiteKey: turnstileEnabled(ctx.env) ? ctx.env.TURNSTILE_SITE_KEY!.trim() : null,
      jupiter: false,
      websiteVerification: ctx.env.FEATURE_WEBSITE_VERIFY === '1',
      manualReview: manualReviewEnabled(ctx.env, ctx.cluster),
    },
    explorer: explorerTemplates(ctx.cluster),
    buildId: ctx.env.BUILD_ID ?? '',
  };
  return json(out, 200, CACHE.config);
}

/* ------------------------------------------------------------------------------------------------ health */

let googleHealth: { at: number; v: HealthCheck } | null = null;
let twilioHealth: { at: number; v: HealthCheck } | null = null;

type ChainChecks = Pick<HealthResponse['checks'], 'alchemy' | 'genesis' | 'program' | 'config' | 'attestor' | 'alt'> & { slot: number | null };

/**
 * The chain part of /api/health (getGenesisHash + one getMultipleAccounts), shared per isolate for 15 s and
 * de-duplicated while in flight: public traffic on /api/health can never spend the RPC quota faster than that.
 */
const CHAIN_HEALTH_TTL_MS = 15_000;
let chainHealth: { at: number; cluster: string; v: Promise<ChainChecks> } | null = null;

async function readChainChecks(ctx: Ctx): Promise<ChainChecks> {
  const out: ChainChecks = { alchemy: 'error', genesis: 'error', program: 'error', config: 'error', attestor: 'missing', alt: 'missing', slot: null };
  if (!hasSecret(ctx.env.ALCHEMY_API_KEY)) {
    out.alchemy = 'missing';
    return out;
  }
  const rpc = ctx.rpc(4);
  try {
    const g = await rpc.call<string>('getGenesisHash');
    out.alchemy = 'ok';
    out.genesis = g === GENESIS[ctx.cluster] ? 'ok' : 'mismatch';
    const alt = ctx.env.ALT_ADDRESS?.trim();
    const keys = [programIdOf(ctx.env), CONFIG_PDA, ...(alt ? [alt] : [])];
    const res = await rpc.getMultipleAccounts(keys);
    out.slot = res.slot;
    const [prog, cfgAcc, altAcc] = res.accounts;
    out.program = prog && prog.executable ? 'ok' : 'missing';
    if (cfgAcc) {
      try {
        const c = decodeConfig(cfgAcc.data);
        out.config = c.flavor === ctx.cluster ? 'ok' : 'mismatch';
        const att = await attestorPubkey(ctx.env);
        out.attestor = !att ? 'missing' : att === c.attestor ? 'ok' : 'mismatch';
      } catch {
        out.config = 'error';
      }
    } else out.config = 'missing';
    if (alt) {
      try {
        out.alt = altAcc && altAcc.owner === 'AddressLookupTab1e1111111111111111111111111' && !altProblems(decodeAlt(altAcc.data)).length ? 'ok' : 'mismatch';
      } catch {
        out.alt = 'error';
      }
    }
  } catch (e) {
    if (e instanceof ApiErr && e.code === 'chain_mismatch') {
      out.alchemy = 'ok';
      out.genesis = 'mismatch';
    } else out.alchemy = 'error';
  }
  return out;
}

function chainChecks(ctx: Ctx, now: number): Promise<ChainChecks> {
  const hit = chainHealth;
  if (hit && hit.cluster === ctx.cluster && now - hit.at < CHAIN_HEALTH_TTL_MS) return hit.v;
  const v = readChainChecks(ctx);
  chainHealth = { at: now, cluster: ctx.cluster, v };
  // a failed read is not cached for the full TTL: the next request after 2 s tries again
  void v.then((r) => {
    if (r.alchemy !== 'ok' && chainHealth?.v === v) chainHealth = { ...chainHealth, at: now - CHAIN_HEALTH_TTL_MS + 2_000 };
  });
  return v;
}

/** Test helper. */
export function __resetHealthCache(): void {
  chainHealth = null;
  googleHealth = null;
  twilioHealth = null;
  faucetCache.clear();
}

export async function handleHealth(ctx: Ctx): Promise<Response> {
  await limit(ctx.env.RL_READ, `read:${ctx.ipHash}`);
  const now = ctx.deps.now();
  const checks: HealthResponse['checks'] = {
    google: 'missing',
    alchemy: 'error',
    genesis: 'error',
    program: 'error',
    config: 'error',
    attestor: 'missing',
    alt: 'missing',
    d1: 'error',
    phone: 'n/a',
    turnstile: 'n/a',
    priceFeed: 'missing',
    indexer: 'stale',
    faucet: ctx.cluster === 'devnet' ? 'missing' : 'n/a',
  };
  let solUsd: number | null = null;
  let solUsdAgeSec: number | null = null;
  let indexerLagSec: number | null = null;

  // D1 + kv snapshot
  try {
    const snap = await metaSnapshot(ctx, true);
    checks.d1 = 'ok';
    if (snap.solUsd) {
      solUsdAgeSec = Math.round((now - snap.solUsd.at) / 1000);
      solUsd = snap.solUsd.usd;
      checks.priceFeed = now - snap.solUsd.at <= SOL_USD_MAX_AGE_MS ? 'ok' : 'stale';
    }
    if (snap.indexerLastRun) {
      indexerLagSec = Math.round((now - snap.indexerLastRun) / 1000);
      // stale after 3 missed cron periods (3 min on mainnet, 15 min on devnet)
      checks.indexer = now - snap.indexerLastRun < 3 * cronPeriodMs(ctx.cluster) ? 'ok' : 'stale';
    }
    // devnet faucet: 'ok' only when it can actually pay out (the airdrop refuses below FAUCET_PAYOUT_FLOOR_LAMPORTS)
    if (ctx.cluster === 'devnet' && snap.faucetLamports !== null) checks.faucet = faucetCanPay(snap.faucetLamports) ? 'ok' : 'stale';
  } catch {
    checks.d1 = 'error';
  }

  // Google (free IDs-only lookup, cached 10 min)
  if (hasSecret(ctx.env.GOOGLE_SERVER_KEY)) {
    if (googleHealth && now - googleHealth.at < 600_000) checks.google = googleHealth.v;
    else {
      try {
        const p = await lookupPlaceIdOnly(ctx);
        checks.google = p ? 'ok' : 'error';
      } catch {
        checks.google = 'error';
      }
      googleHealth = { at: now, v: checks.google };
    }
  }

  // chain: genesis, program, Config, ALT, attestor (cached 15 s per isolate)
  const chain = await chainChecks(ctx, now);
  const slot = chain.slot;
  checks.alchemy = chain.alchemy;
  checks.genesis = chain.genesis;
  checks.program = chain.program;
  checks.config = chain.config;
  checks.attestor = chain.attestor;
  checks.alt = chain.alt;
  if (!(await attestorPubkey(ctx.env))) checks.attestor = 'missing';

  // phone / turnstile
  const mode = phoneMode(ctx.env, ctx.cluster);
  if (mode === 'screen') checks.phone = 'ok';
  else if (mode === 'call' && twilioConfigured(ctx.env)) {
    // Twilio service lookup, cached 5 min per isolate (an uncached public route must not hammer it)
    if (!twilioHealth || now - twilioHealth.at >= 300_000) twilioHealth = { at: now, v: await new TwilioVerifier(ctx.env, ctx.deps).health() };
    checks.phone = twilioHealth.v;
  }
  // phone verification is optional (mainnet starts without Twilio): none of the TWILIO_* secrets = 'n/a', only some = 'missing'
  else checks.phone = twilioPartlyConfigured(ctx.env) ? 'missing' : 'n/a';
  // Turnstile guards only the 'call me' step, so without phone calls it is not needed
  checks.turnstile = turnstileEnabled(ctx.env) ? 'ok' : ctx.cluster === 'mainnet' && mode === 'call' ? 'missing' : 'n/a';

  const must: (keyof HealthResponse['checks'])[] = ['google', 'alchemy', 'genesis', 'program', 'config', 'attestor', 'alt', 'd1', 'priceFeed'];
  const ok = must.every((k) => checks[k] === 'ok') && checks.indexer !== 'stale';
  const out: HealthResponse = {
    ok,
    service: 'cornershop-api',
    cluster: ctx.cluster,
    buildId: ctx.env.BUILD_ID ?? '',
    checks,
    solUsd: solUsd !== null && solUsdAgeSec !== null && solUsdAgeSec * 1000 <= SOL_USD_MAX_AGE_MS ? solUsd : null,
    solUsdAgeSec,
    indexerLagSec,
    slot,
  };
  return json(out, 200, CACHE.none);
}

async function lookupPlaceIdOnly(ctx: Ctx): Promise<boolean> {
  // Google Sydney (SPEC §3.1 test vector) with the IDs-only field mask (free SKU)
  return verifyPlaceIdOnly(ctx.env, ctx.deps, 'ChIJN1t_tDeuEmsRUsoyG83frY4');
}

/* ---------------------------------------------------------------------------------------------- index/tx */

export async function handleIndexTx(ctx: Ctx, request: Request): Promise<Response> {
  await limit(ctx.env.RL_WRITE, `write:${ctx.ipHash}`);
  const body = await readJsonObject(request);
  if (!isSignature(body.signature)) throw new ApiErr('bad_request', 'Invalid signature');
  const indexed = await indexTx(ctx, body.signature as string);
  return json({ indexed } satisfies IndexTxResponse, 200);
}
