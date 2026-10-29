/**
 * DEVNET ONLY — `POST /api/dev/airdrop` and the faucet balance (INTEGRATION §3.8, H6). This module is imported only
 * behind an inline `if (__CS_DEV_ENDPOINTS__)` guard, so mainnet bundles do not contain it
 * (scripts/check-bundle.mjs proves it). At runtime it additionally requires CLUSTER === 'devnet', the devnet genesis
 * hash and the faucet secret; otherwise 404 not_enabled. The only reader of the devnet faucet secret.
 *
 * Sends min(1 SOL, remaining caps, the faucet's share) from the faucet key to `address` (a System transfer built and
 * signed here), only when the address holds < 1 SOL. The share is half of what the faucet can spend (balance − 0.05 SOL
 * for fees), but at least 0.25 SOL (enough on devnet to launch, trade and claim): a well-funded faucet pays 1 SOL, a
 * low one still serves the next testers instead of refusing everyone below a 1.1 SOL floor (QA round 2: the public
 * devnet airdrop is dry, so the faucet is refilled by hand). Caps: 2 SOL/day/address, 3 SOL/day/IP, 30 SOL/day overall,
 * each reserved atomically before the send (released again if nothing was sent). Spendable < 0.25 SOL → 503
 * faucet_empty. The faucet balance in kv_meta is updated after every payout. Returns after `confirmed`.
 */
import { canonicalPubkey } from '../bytes';
import { capValue, DAY, kvPutStmt, limit, type Ctx } from '../ctx';
import { ApiErr, json, readJsonObject } from '../http';
import { loadSigningKey, type SigningKey } from '../keys';
import { ensureGenesis, isConfirmed, type Rpc } from '../solana';
import { buildSignedTx, systemTransfer } from '../txbuild';
import type { DevAirdropResponse } from '../wire';

const SOL = 1_000_000_000n;
/** Kept for the faucet's own fees. */
const FAUCET_RESERVE = SOL / 20n;
/** The smallest payout: enough on devnet for a launch, a few 0.1 SOL trades and a claim. */
const MIN_PAYOUT = SOL / 4n;
/** = FAUCET_RESERVE + MIN_PAYOUT; worker/configRoute.ts FAUCET_PAYOUT_FLOOR_LAMPORTS must match (e2e test). */
export const FAUCET_FLOOR = FAUCET_RESERVE + MIN_PAYOUT;
const PER_ADDRESS = 2n * SOL;
const PER_IP = 3n * SOL;
const PER_DAY = 30n * SOL;

async function faucetKey(ctx: Pick<Ctx, 'env'>): Promise<SigningKey | null> {
  try {
    return await loadSigningKey(ctx.env.DEV_FAUCET_SECRET, 'faucet');
  } catch {
    return null;
  }
}

export async function faucetBalance(ctx: Pick<Ctx, 'env' | 'cluster'>, rpc: Rpc): Promise<bigint | null> {
  if (ctx.cluster !== 'devnet') return null;
  const k = await faucetKey(ctx);
  if (!k) return null;
  return rpc.getBalance(k.publicKey);
}

/**
 * Atomically adds `amount` to a daily counter only while the result stays ≤ `max` (one conditional UPSERT, so parallel
 * requests cannot all pass a read-then-write check). Returns false when it would exceed the cap (nothing changed).
 */
async function reserveAmount(db: D1Database, key: string, amount: bigint, max: bigint, now: number): Promise<boolean> {
  const start = Math.floor(now / DAY) * DAY;
  const row = await db
    .prepare(
      `INSERT INTO rate_counters(key, window_start, count) SELECT ?1, ?2, ?3 WHERE ?3 <= ?4
       ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = ?2 THEN count + ?3 ELSE ?3 END, window_start = ?2
       WHERE (CASE WHEN rate_counters.window_start = ?2 THEN rate_counters.count ELSE 0 END) + ?3 <= ?4
       RETURNING count`,
    )
    .bind(key, start, Number(amount), Number(max))
    .first<{ count: number }>();
  return !!row;
}

/** Gives back a reservation (the transfer was never sent). */
async function releaseAmount(db: D1Database, key: string, amount: bigint, now: number): Promise<void> {
  const start = Math.floor(now / DAY) * DAY;
  await db
    .prepare('UPDATE rate_counters SET count = MAX(0, count - ?3) WHERE key = ?1 AND window_start = ?2')
    .bind(key, start, Number(amount))
    .run();
}

export async function handleDevAirdrop(ctx: Ctx, request: Request): Promise<Response> {
  if (ctx.cluster !== 'devnet') throw new ApiErr('not_enabled', 'Not available');
  const key = await faucetKey(ctx);
  if (!key) throw new ApiErr('not_enabled', 'Not available');
  await limit(ctx.env.RL_WRITE, `write:${ctx.ipHash}`);
  const body = await readJsonObject(request);
  const address = canonicalPubkey(body.address);
  if (!address || address === key.publicKey) throw new ApiErr('bad_request', 'Invalid address');
  const rpc = ctx.rpc(30);
  await ensureGenesis(rpc); // devnet genesis only (the Rpc cluster is 'devnet')
  const now = ctx.deps.now();
  const [have, faucet] = await Promise.all([rpc.getBalance(address), rpc.getBalance(key.publicKey)]);
  if (have >= SOL) throw new ApiErr('bad_request', 'This wallet already has test SOL');
  if (faucet < FAUCET_FLOOR) {
    ctx.waitUntil(kvPutStmt(ctx.db, 'faucet_balance', Number(faucet), now).run());
    throw new ApiErr('faucet_empty', 'The test faucet is empty. Use faucet.solana.com.');
  }
  const half = (faucet - FAUCET_RESERVE) / 2n;
  const share = half > MIN_PAYOUT ? half : MIN_PAYOUT;
  const [byAddr, byIp, total] = await Promise.all([
    capValue(ctx.db, `faucet:addr:${address}`, DAY, now),
    capValue(ctx.db, `faucet:ip:${ctx.ipHash}`, DAY, now),
    capValue(ctx.db, 'faucet:all', DAY, now),
  ]);
  const room = [PER_ADDRESS - BigInt(byAddr), PER_IP - BigInt(byIp), PER_DAY - BigInt(total), SOL].reduce((a, b) => (b < a ? b : a));
  const capErr = () => new ApiErr('faucet_cap', 'Daily test SOL limit reached. Try again tomorrow.', { retryAfterSec: Math.ceil((DAY - (now % DAY)) / 1000) });
  if (room < SOL / 100n) throw capErr();
  const amount = room < share ? room : share;
  // Reserve the amount on every cap atomically BEFORE sending (parallel requests cannot all pass); undo on failure.
  const caps: [string, bigint][] = [
    [`faucet:ip:${ctx.ipHash}`, PER_IP],
    [`faucet:addr:${address}`, PER_ADDRESS],
    ['faucet:all', PER_DAY],
  ];
  const held: string[] = [];
  const releaseAll = () => Promise.all(held.map((k) => releaseAmount(ctx.db, k, amount, now).catch(() => undefined)));
  for (const [k, max] of caps) {
    if (!(await reserveAmount(ctx.db, k, amount, max, now))) {
      await releaseAll();
      throw capErr();
    }
    held.push(k);
  }
  let signature: string;
  let lastValidBlockHeight: number;
  try {
    const bh = await rpc.getLatestBlockhash();
    lastValidBlockHeight = bh.lastValidBlockHeight;
    const tx = await buildSignedTx(key, [systemTransfer(key.publicKey, address, amount)], bh.blockhash);
    signature = await rpc.sendTransaction(tx.base64);
  } catch (e) {
    await releaseAll();
    throw e;
  }
  // the faucet just paid out: keep /api/config + /api/health on the real balance (5 000 lamports fee)
  ctx.waitUntil(kvPutStmt(ctx.db, 'faucet_balance', Number(faucet - amount - 5_000n), now).run());
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 800));
    const st = await rpc.getSignatureStatus(signature);
    if (st?.err) throw new ApiErr('upstream', 'The airdrop failed. Try again.');
    if (isConfirmed(st)) {
      ctx.log.info('dev.airdrop', { lamports: Number(amount) });
      return json({ signature, lamports: amount.toString() } satisfies DevAirdropResponse, 200);
    }
    if (rpc.remaining < 2) break;
    const height = await rpc.call<number>('getBlockHeight', [{ commitment: 'confirmed' }]).catch(() => 0);
    if (height > lastValidBlockHeight) break;
  }
  throw new ApiErr('upstream', 'The airdrop is taking longer than usual. Check your balance in a minute.');
}
