/**
 * Per-request / per-cron context for the Phase-2 routes, plus the rate-limit helpers (§3.0, §3.1): Workers rate-limit
 * bindings for per-minute limits, D1 `rate_counters` for durable hourly/daily caps.
 */
import type { EmailMessageFactory } from './email';
import type { Env } from './env';
import { ApiErr } from './http';
import type { Logger } from './log';
import { alertSubject, deliverAlert } from './notify';
import { Rpc, type FetchDep } from './solana';
import type { ApiErrorCode, Cluster } from './wire';

export interface Deps extends FetchDep {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  /** Waits between status polls (tests pass an instant one); default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Builds the alert email (worker/email.ts; tests pass a fake); default `new EmailMessage` from 'cloudflare:email'. */
  emailMessage?: EmailMessageFactory;
}

export const sleepFor = (deps: Pick<Deps, 'sleep'>, ms: number): Promise<void> => (deps.sleep ? deps.sleep(ms) : new Promise((r) => setTimeout(r, ms)));

export const defaultDeps = (): Deps => ({ fetch: (i, init) => fetch(i, init), now: () => Date.now() });

export interface Ctx {
  env: Env;
  cluster: Cluster;
  db: D1Database;
  deps: Deps;
  log: Logger;
  /** PUBLIC_ORIGIN, e.g. https://cornershop-devnet.tiejiucai.workers.dev */
  origin: string;
  /** HMAC('ip:'+ip) truncated to 16 bytes (never the raw IP). */
  ipHash: string;
  waitUntil: (p: Promise<unknown>) => void;
  /** A fresh RPC client with its own fetch budget. */
  rpc: (budget?: number) => Rpc;
}

export function makeRpcFactory(env: Env, cluster: Cluster, deps: Deps): (budget?: number) => Rpc {
  return (budget = 30) => new Rpc(env, cluster, deps, budget);
}

/** Per-minute limit through a Workers rate-limit binding (absent in tests/local without bindings → no limit). */
export async function limit(binding: RateLimit | undefined, key: string, retryAfterSec = 10): Promise<void> {
  if (!binding) return;
  let ok = true;
  try {
    ok = (await binding.limit({ key })).success;
  } catch {
    ok = true; // fail open on binding errors (D1 caps still apply)
  }
  if (!ok) throw new ApiErr('rate_limited', 'Too many requests. Wait a few seconds and try again.', { retryAfterSec });
}

/**
 * Durable fixed-window counter in D1. Increments and returns the new count; throws `code` (429) when it exceeds
 * `max`. Windows are aligned to `windowMs` (hour/day).
 */
export async function cap(
  db: D1Database,
  key: string,
  max: number,
  windowMs: number,
  now: number,
  code: ApiErrorCode = 'rate_limited',
  message = 'Too many requests. Try again later.',
): Promise<number> {
  const start = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .prepare(
      `INSERT INTO rate_counters(key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END, window_start = ?2
       RETURNING count`,
    )
    .bind(key, start)
    .first<{ count: number }>();
  const n = row?.count ?? 1;
  if (n > max) throw new ApiErr(code, message, { retryAfterSec: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) });
  return n;
}

/** Gives back one count taken by `cap` in the same window (an attempt that was refused or failed later on). */
export async function uncap(db: D1Database, key: string, windowMs: number, now: number): Promise<void> {
  const start = Math.floor(now / windowMs) * windowMs;
  await db.prepare('UPDATE rate_counters SET count = MAX(0, count - 1) WHERE key = ?1 AND window_start = ?2').bind(key, start).run();
}

/** Read a counter without incrementing. */
export async function capValue(db: D1Database, key: string, windowMs: number, now: number): Promise<number> {
  const start = Math.floor(now / windowMs) * windowMs;
  const row = await db.prepare('SELECT window_start, count FROM rate_counters WHERE key = ?1').bind(key).first<{ window_start: number; count: number }>();
  return row && row.window_start === start ? row.count : 0;
}

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/**
 * How often the indexer cron fires (wrangler.jsonc `triggers`): every minute on mainnet, every 5 minutes on devnet (both
 * share one account's D1 budget on Workers Free). Every "the cron should have run by now" window scales with it.
 */
export function cronPeriodMs(cluster: Cluster): number {
  return cluster === 'devnet' ? 5 * 60_000 : 60_000;
}

/* ------------------------------------------------------------------------------------------------ kv_meta */

export async function kvGet<T>(db: D1Database, key: string): Promise<{ value: T; updatedAt: number } | null> {
  const row = await db.prepare('SELECT value, updated_at FROM kv_meta WHERE key = ?1').bind(key).first<{ value: string; updated_at: number }>();
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value) as T, updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

const kvJson = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

export function kvPutStmt(db: D1Database, key: string, value: unknown, now: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO kv_meta(key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3')
    .bind(key, kvJson(value), now);
}

/**
 * kvPutStmt that leaves an unchanged value alone (D1 bills a rewrite of the same value as a row written). Only for
 * keys whose readers never look at `updated_at`.
 */
export function kvPutIfChangedStmt(db: D1Database, key: string, value: unknown, now: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO kv_meta(key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3 WHERE kv_meta.value IS NOT ?2')
    .bind(key, kvJson(value), now);
}

export async function kvPut(db: D1Database, key: string, value: unknown, now: number): Promise<void> {
  await kvPutStmt(db, key, value, now).run();
}

/**
 * Inserts an alert row and (best effort, warn and critical only) sends it to the owner: the webhook and/or the email
 * (worker/notify.ts). Never includes secrets. The same kind + ref is sent at most once per `dedupeMs` (an hour).
 */
export async function alert(
  ctx: Pick<Ctx, 'db' | 'env' | 'deps' | 'log' | 'cluster'>,
  severity: 'info' | 'warn' | 'critical',
  kind: string,
  message: string,
  ref?: string,
  dedupeMs = HOUR,
): Promise<void> {
  const now = ctx.deps.now();
  try {
    const dup = await ctx.db
      .prepare('SELECT id FROM alerts WHERE kind = ?1 AND ref IS ?2 AND created_at > ?3 LIMIT 1')
      .bind(kind, ref ?? null, now - dedupeMs)
      .first();
    if (dup) return;
    await ctx.db
      .prepare('INSERT INTO alerts(severity, kind, message, ref, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(severity, kind, message.slice(0, 1000), ref ?? null, now)
      .run();
  } catch (e) {
    ctx.log.error('alert.store_failed', { kind, error: e instanceof Error ? e.message : 'error' });
  }
  ctx.log[severity === 'critical' ? 'error' : 'warn']('alert', { severity, kind, message: message.slice(0, 300), ref: ref ?? null });
  if (severity !== 'info') {
    const text = `[AtlasPad ${ctx.cluster}] ${severity.toUpperCase()} ${kind}: ${message}`;
    await deliverAlert(ctx.env, ctx.deps, alertSubject(ctx.cluster, severity, kind, message), text, ctx.log);
  }
}
