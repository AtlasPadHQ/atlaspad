/**
 * Owner alerts: the site owner hears about every claim, dispute, report, opt-out and manual-review request as it
 * happens, on every alert channel that is set up (worker/notify.ts): the webhook (`ALERT_WEBHOOK_URL`, a free Discord
 * or Slack incoming webhook) and the email (`ALERT_EMAIL_TO` through Cloudflare Email Routing, free), with what is
 * needed to act: shop name, ticker, place id, claimant wallet (short), unlock time, coin page and explorer.
 *
 *  - claim co-signed  claim cosign (worker/claims.ts), the one step every on-chain request_claim needs: a claimant
 *                     who sends the transaction through another RPC and never calls /api/claim/confirm is still
 *                     announced. One message per place + nonce + wallet a day: the same claimant's retries are not
 *                     repeated, another wallet co-signed at the same nonce is (the claims lane's hourly cap bounds a
 *                     flood, but each place still gets one claim or co-sign message an hour past it).
 *  - claim requested  claim confirm (worker/claims.ts) and, for a claim whose browser never confirmed, the program
 *                     monitor's ClaimRequested (worker/indexer.ts). One message per claim (ref = place + nonce).
 *                     Website-code claims, and any re-claim of an owned shop, are flagged for a human check before
 *                     the public window ends (the guardian cancels a wrong one: scripts/claims-admin.mjs). The vault
 *                     sweep also raises `claim_pending_onchain` for a claim pending on chain that no claim confirm
 *                     recorded (worker/indexer.ts).
 *  - report / dispute / opt-out / manual review   POST /api/report and /api/claim/manual. A report against a coin
 *                     whose claim is in its public window is a dispute.
 *
 * Privacy: never a phone number, an email, a name or a report's free text (they stay in D1 for scripts/moderate.mjs).
 * Shop name and ticker are the coin's public metadata, cleaned of markup.
 *
 * Never fails a request: callers pass `notifyOwner(...)` to ctx.waitUntil and every error is swallowed (logged). Each
 * alert is stored in D1 `alerts` first (the watchdog lists unacknowledged ones), de-duplicated atomically there, and
 * at most OWNER_ALERTS_PER_HOUR are posted per hour and lane; the first one over says the rest are held back. Claims
 * and disputes have their own lane: anyone can file reports, and a flood of them must never hold back the alert that
 * asks for a human check before a claim unlocks. Past the claims lane's cap, each place still gets one claim or co-sign
 * message an hour (it may be the only word before that claim unlocks); each needs a verified claim, so they cannot
 * become a flood of their own.
 */
import { cap, DAY, HOUR, uncap, type Ctx } from './ctx';
import { errMsg } from './log';
import { alertSubject, deliverAlert, hasAlertChannel } from './notify';
import { multiTenantSuffix } from './website';
import type { Cluster } from './wire';

export type OwnerAlertCtx = Pick<Ctx, 'db' | 'env' | 'deps' | 'log' | 'cluster' | 'origin'>;

export type OwnerEvent =
  | {
      kind: 'claim';
      placeId: string;
      method: 'call' | 'screen' | 'website' | 'manual';
      newOwner: string;
      /** The owner the claim would replace (a re-claim of an owned shop), else null. */
      previousOwner: string | null;
      nonce: number;
      /** Unix seconds. */
      unlockTs: number | null;
      inProbation?: boolean;
      sig?: string | null;
      /** Website-code claims: the listing's own host the code was found on. */
      websiteHost?: string | null;
    }
  | {
      /** The attestor co-signed a request_claim (claim cosign): it may land on chain any moment, or never. */
      kind: 'claim_cosigned';
      placeId: string;
      method: 'call' | 'screen' | 'website' | 'manual';
      newOwner: string;
      previousOwner: string | null;
      /** The nonce the co-signed request_claim must carry (VaultState claim_nonce + 1). */
      nonce: number;
      websiteHost?: string | null;
    }
  | {
      kind: 'report' | 'optout' | 'manual_claim';
      placeId: string | null;
      mint: string | null;
      /** The request's reason (REPORT_REASON_RE); the alert shows it only when it is one of REPORT_REASON_KEYS. */
      reason: string;
      /** manual_claim: the wallet that should own the shop. */
      wallet?: string | null;
    };

/** The coin facts an alert shows (public registry fields only). */
export interface AlertCoin {
  place_id: string;
  mint: string;
  ticker: string;
  name: string;
  status: string;
  owner: string | null;
  pending_owner: string | null;
  unlock_ts: number | null;
}

export interface OwnerAlert {
  kind: 'owner_claim' | 'owner_cosign' | 'owner_dispute' | 'owner_report' | 'owner_optout' | 'owner_manual';
  severity: 'info' | 'warn';
  /** De-duplication key (with `kind`), within `dedupeMs`. */
  ref: string;
  dedupeMs: number;
  /** The message (plain text, one fact per line): the webhook post and the email body. */
  text: string;
  /** The email subject (`[AtlasPad devnet] WARN owner_claim: …`, under 120 characters). */
  subject: string;
}

/** Posted per hour, cluster and lane at most; the rest stay in D1 `alerts` (scripts/watchdog.mjs lists them). */
export const OWNER_ALERTS_PER_HOUR = 30;
const CLAIM_DEDUPE_MS = 30 * DAY;
const REPORT_DEDUPE_MS = HOUR;

/** The hourly budget an alert counts against: claims and disputes (act before unlock) never share it with reports. */
export function alertLane(kind: OwnerAlert['kind']): 'claims' | 'reports' {
  return kind === 'owner_claim' || kind === 'owner_cosign' || kind === 'owner_dispute' ? 'claims' : 'reports';
}

/** How a claim was verified, in words. */
function claimHow(method: 'call' | 'screen' | 'website' | 'manual'): string {
  return method === 'website' ? 'website code' : method === 'manual' ? 'manual review' : method === 'screen' ? 'devnet on-screen code' : 'phone call';
}

/**
 * The reason keys the site sends (the Report sheet, the opt-out form, manual review). The API accepts any short word
 * key (REPORT_REASON_RE allows digits and spaces), so anything else is shown as 'other': a crafted reason must never
 * carry free text, a phone number or a message into the owner's channel.
 */
export const REPORT_REASON_KEYS: readonly string[] = ['impersonation', 'offensive', 'scam', 'other', 'optout', 'manual_claim'];

export function reasonKey(reason: string): string {
  return REPORT_REASON_KEYS.includes(reason) ? reason : 'other';
}

/** `7xKX…9fQa` */
export function shortWallet(w: string | null | undefined): string {
  if (!w) return '—';
  return w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

/** User-chosen text (shop names, tickers) without markup, mentions or line breaks; ≤ 60 characters. */
export function plain(s: string | null | undefined): string {
  return (
    String(s ?? '')
      // control, zero-width / bidi format characters and line separators (spoofing, broken lines)
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/[<>@`*_~|[\]()\\#]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || '—'
  );
}

/** `2026-10-29 12:00 UTC (in 72 h)` */
export function unlockText(unlockTs: number | null | undefined, now: number): string {
  if (!unlockTs) return '—';
  const at = new Date(unlockTs * 1000).toISOString().replace('T', ' ').slice(0, 16);
  const secs = unlockTs - Math.floor(now / 1000);
  const left = secs <= 0 ? 'now' : secs < 2 * 3600 ? `in ${Math.max(1, Math.round(secs / 60))} min` : `in ${Math.round(secs / 3600)} h`;
  return `${at} UTC (${left})`;
}

function solscan(cluster: Cluster, kind: 'token' | 'tx' | 'account', id: string): string {
  return `https://solscan.io/${kind}/${id}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
}

/** The alert for `ev` (pure: tests build every variant from here). */
export function ownerAlertFor(ev: OwnerEvent, coin: AlertCoin | null, at: { cluster: Cluster; origin: string; now: number }): OwnerAlert {
  const { cluster, origin, now } = at;
  const placeId = ev.kind === 'claim' || ev.kind === 'claim_cosigned' ? ev.placeId : (ev.placeId ?? coin?.place_id ?? null);
  const lines: string[] = [];
  const shop = () => lines.push(coin ? `Shop: ${plain(coin.name)} ($${plain(coin.ticker)})${coin.status === 'hidden' ? ' · hidden from the map' : ''}` : 'Shop: no coin yet');
  const place = () => lines.push(`Place: ${placeId ?? '—'}`);
  const links = (sig?: string | null) => {
    if (coin) {
      lines.push(`Coin: <${origin}/c/${coin.mint}>`);
      lines.push(`Explorer: <${solscan(cluster, 'token', coin.mint)}>`);
    } else if (placeId) lines.push(`Place page: <${origin}/p/${encodeURIComponent(placeId)}>`);
    if (sig) lines.push(`Claim tx: <${solscan(cluster, 'tx', sig)}>`);
  };
  const cancelHint = () => {
    if (placeId) lines.push(`If it is wrong, the guardian cancels it before it unlocks: node scripts/claims-admin.mjs --env ${cluster} cancel ${placeId}`);
  };
  // a customer subdomain of a hosting platform is accepted as the business's site, but anyone can sign up for one (or
  // take over an abandoned one): the human check must look at it
  const website = (method: string, host?: string | null) => {
    if (method !== 'website' || !host) return;
    lines.push(`Website: ${plain(host)}`);
    const tenant = multiTenantSuffix(host);
    if (tenant) lines.push(`Multi-tenant host (${tenant}): check the subdomain is the business's own`);
  };
  let kind: OwnerAlert['kind'];
  let severity: OwnerAlert['severity'] = 'info';
  let title: string;
  let ref: string;
  let dedupeMs = REPORT_DEDUPE_MS;

  if (ev.kind === 'claim') {
    kind = 'owner_claim';
    ref = `claim:${ev.placeId}:${ev.nonce}`;
    dedupeMs = CLAIM_DEDUPE_MS;
    const reclaim = !!ev.previousOwner && ev.previousOwner !== ev.newOwner;
    const how = claimHow(ev.method);
    const check = reclaim || ev.method === 'website' || ev.method === 'manual';
    severity = check ? 'warn' : 'info';
    title = reclaim
      ? `Re-claim of an owned shop (${how}): needs a human check before unlock`
      : ev.method === 'website'
        ? 'Website-code claim requested: needs a human check before unlock'
        : ev.method === 'manual'
          ? 'Manual-review claim requested: needs a human check before unlock'
          : `Phone claim requested (${how})`;
    shop();
    place();
    lines.push(`Claimant: ${shortWallet(ev.newOwner)}`);
    if (reclaim) lines.push(`Current owner: ${shortWallet(ev.previousOwner)}`);
    website(ev.method, ev.websiteHost);
    lines.push(`Unlocks: ${unlockText(ev.unlockTs, now)}${ev.inProbation ? ' · probation (longer window)' : ''}`);
    links(ev.sig);
    if (check) cancelHint();
  } else if (ev.kind === 'claim_cosigned') {
    // Always a warning: the claimant holds a signed claim and may send it through any RPC without telling us, so this
    // can be the only message before the window ends. The later claim alert (unlock time, tx) follows when it lands.
    kind = 'owner_cosign';
    severity = 'warn';
    ref = `cosign:${ev.placeId}:${ev.nonce}:${ev.newOwner}`;
    dedupeMs = DAY;
    const reclaim = !!ev.previousOwner && ev.previousOwner !== ev.newOwner;
    title = reclaim ? `Re-claim of an owned shop co-signed (${claimHow(ev.method)})` : `Claim co-signed (${claimHow(ev.method)})`;
    shop();
    place();
    lines.push(`Claimant: ${shortWallet(ev.newOwner)}`);
    if (reclaim) lines.push(`Current owner: ${shortWallet(ev.previousOwner)}`);
    website(ev.method, ev.websiteHost);
    lines.push(`Not on-chain yet. If no claim alert follows, check: node scripts/claims-admin.mjs --env ${cluster} list`);
    links();
    cancelHint();
  } else {
    const reason = reasonKey(ev.reason);
    const pendingNow = !!coin?.pending_owner && (coin.unlock_ts ?? 0) > Math.floor(now / 1000);
    const key = placeId ?? ev.mint ?? '-';
    if (ev.kind === 'report' && pendingNow) {
      kind = 'owner_dispute';
      severity = 'warn';
      title = `Dispute filed against a pending claim (reason: ${reason})`;
      ref = `dispute:${key}`;
      shop();
      place();
      lines.push(`Claimant: ${shortWallet(coin?.pending_owner)}`);
      lines.push(`Unlocks: ${unlockText(coin?.unlock_ts, now)}`);
      links();
      lines.push(`Read it: node scripts/moderate.mjs --env ${cluster} --reports`);
      cancelHint();
    } else if (ev.kind === 'report') {
      kind = 'owner_report';
      title = `Report filed (reason: ${reason})`;
      ref = `report:${key}:${reason}`;
      shop();
      place();
      links();
      lines.push(`Read it: node scripts/moderate.mjs --env ${cluster} --reports`);
    } else if (ev.kind === 'optout') {
      kind = 'owner_optout';
      title = 'Opt-out requested: the business asks not to be listed';
      ref = `optout:${key}`;
      shop();
      place();
      links();
      lines.push(`Contact details: node scripts/moderate.mjs --env ${cluster} --reports --show-contact`);
      if (placeId) lines.push(`After checking the requester: node scripts/moderate.mjs --env ${cluster} --optout ${placeId} --execute`);
    } else {
      kind = 'owner_manual';
      title = 'Manual-review claim requested';
      ref = `manual:${key}`;
      shop();
      place();
      lines.push(`Claimant: ${shortWallet(ev.wallet)}`);
      links();
      lines.push(`Read it: node scripts/moderate.mjs --env ${cluster} --reports`);
    }
  }
  const text = [`[AtlasPad ${cluster}] ${title}`, ...lines].join('\n');
  return { kind, severity, ref, dedupeMs, text, subject: alertSubject(cluster, severity, kind, title) };
}

async function coinFor(ctx: OwnerAlertCtx, ev: OwnerEvent): Promise<AlertCoin | null> {
  const placeId = ev.placeId ?? '';
  const mint = ev.kind === 'claim' || ev.kind === 'claim_cosigned' ? '' : (ev.mint ?? '');
  if (!placeId && !mint) return null;
  return ctx.db
    .prepare('SELECT place_id, mint, ticker, name, status, owner, pending_owner, unlock_ts FROM coins WHERE (place_id = ?1 OR mint = ?2) AND cluster = ?3 LIMIT 1')
    .bind(placeId, mint, ctx.cluster)
    .first<AlertCoin>();
}

/**
 * Stores the owner alert for `ev` and sends it to the owner's channels. Never rejects. Pass it to ctx.waitUntil so the
 * request never waits on (or fails with) the webhook or the email.
 */
export async function notifyOwner(ctx: OwnerAlertCtx, ev: OwnerEvent): Promise<void> {
  try {
    const now = ctx.deps.now();
    const a = ownerAlertFor(ev, await coinFor(ctx, ev), { cluster: ctx.cluster, origin: ctx.origin, now });
    // store + de-duplicate in one statement: the confirm route and the program monitor may race on the same claim
    const stored = await ctx.db
      .prepare(
        `INSERT INTO alerts(severity, kind, message, ref, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE kind = ?2 AND ref = ?4 AND created_at > ?6)
         RETURNING id`,
      )
      .bind(a.severity, a.kind, a.text.split('\n').join(' · ').slice(0, 1000), a.ref, now, now - a.dedupeMs)
      .first<{ id: number }>();
    if (!stored) return;
    ctx.log.info('owner_alert', { kind: a.kind, severity: a.severity });
    if (!hasAlertChannel(ctx.env)) return;
    const lane = alertLane(a.kind);
    const laneKey = `owner_alerts:${lane}:${ctx.cluster}`;
    const n = await cap(ctx.db, laneKey, Number.MAX_SAFE_INTEGER, HOUR, now);
    let held = n > OWNER_ALERTS_PER_HOUR;
    // past the cap, a place's first claim or co-sign message of the hour still goes out, and gives its lane count back
    // so the "held back" notice still follows; at most OWNER_ALERTS_PER_HOUR such places an hour (devnet claims are free)
    if (held && (ev.kind === 'claim' || ev.kind === 'claim_cosigned')) {
      if (
        (await cap(ctx.db, `owner_alerts:place:${ctx.cluster}:${ev.placeId}`, Number.MAX_SAFE_INTEGER, HOUR, now)) === 1 &&
        (await cap(ctx.db, `owner_alerts:claims_overflow:${ctx.cluster}`, Number.MAX_SAFE_INTEGER, HOUR, now)) <= OWNER_ALERTS_PER_HOUR
      ) {
        held = false;
        await uncap(ctx.db, laneKey, HOUR, now);
      }
    }
    if (held && n > OWNER_ALERTS_PER_HOUR + 1) return;
    const what = lane === 'claims' ? 'claim' : 'report';
    const text = held
      ? `[AtlasPad ${ctx.cluster}] More than ${OWNER_ALERTS_PER_HOUR} ${what} alerts this hour: the rest are held back. List them: node scripts/watchdog.mjs --cluster ${ctx.cluster}`
      : a.text;
    const subject = held ? alertSubject(ctx.cluster, 'warn', 'owner_alerts', `more than ${OWNER_ALERTS_PER_HOUR} ${what} alerts this hour, the rest are held back`) : a.subject;
    if (!(await deliverAlert(ctx.env, ctx.deps, subject, text, ctx.log))) ctx.log.warn('owner_alert.not_delivered', { kind: a.kind });
  } catch (e) {
    ctx.log.warn('owner_alert.failed', { error: errMsg(e) });
  }
}

/**
 * The program monitor saw a ClaimRequested (worker/indexer.ts). A claim with a claims row gets its owner alert here
 * too, so one whose browser never called /api/claim/confirm is still announced (same ref: never twice). Claims without
 * a row raise the critical `claim_unknown` alert instead.
 */
export async function notifyOwnerFromChain(
  ctx: OwnerAlertCtx,
  placeHash: string | null,
  data: { newOwner?: unknown; nonce?: unknown; unlockTs?: unknown },
  sig: string,
): Promise<void> {
  try {
    const newOwner = typeof data.newOwner === 'string' ? data.newOwner : '';
    const nonce = Number(data.nonce);
    if (!placeHash || !newOwner || !Number.isSafeInteger(nonce)) return;
    const row = await ctx.db
      .prepare(
        `SELECT c.method, c.website_host, k.place_id, k.owner FROM claims c JOIN coins k ON k.place_id = c.place_id
         WHERE k.place_hash = ?1 AND c.new_owner = ?2 ORDER BY c.requested_at DESC LIMIT 1`,
      )
      .bind(placeHash, newOwner)
      .first<{ method: 'call' | 'screen' | 'website' | 'manual'; website_host: string | null; place_id: string; owner: string | null }>();
    if (!row) return;
    const unlockTs = Number(data.unlockTs);
    await notifyOwner(ctx, {
      kind: 'claim',
      placeId: row.place_id,
      method: row.method,
      newOwner,
      previousOwner: row.owner && row.owner !== newOwner ? row.owner : null,
      nonce,
      unlockTs: Number.isFinite(unlockTs) && unlockTs > 0 ? unlockTs : null,
      sig,
      websiteHost: row.website_host,
    });
  } catch (e) {
    ctx.log.warn('owner_alert.failed', { error: errMsg(e) });
  }
}
