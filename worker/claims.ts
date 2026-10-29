/**
 * Owner claims, real mode (INTEGRATION §3.5): status → call (phone code: Twilio voice on mainnet, on-screen code on
 * devnet) → check → (browser builds request_claim) → cosign (SPEC §8.4 claim policy + attestor) → (wallet signs,
 * browser sends) → confirm. Finalize happens after the public window (cron crank or anyone); withdraw is the owner's
 * own signature — there are no automatic payouts.
 *
 * Privacy: the phone number is looked up from Google server-side for every call, used in memory, never stored or
 * logged (only HMAC('phone:'+E.164)); codes are never stored (screen: HMAC only); claim tokens are stored as HMACs.
 *
 * Hidden coins (moderation or a business opt-out, coins.status = 'hidden') are hidden from discovery, never from their
 * owner: every claim route here works for them too, and withdrawals never touch the registry. Every claim that is
 * co-signed or goes pending on-chain, and every report, opt-out and manual-review request, alerts the site owner
 * (worker/ownerAlerts.ts).
 */
import { isPremiumNumber, maskPhoneNumber } from './api';
import { configPda, placeAddresses } from './addresses';
import { attestorPubkey, signApproved } from './attestor';
import { canonicalPubkey, fromB64, fromHex, isSignature, timingSafeEq, toB64, toB64Url } from './bytes';
import { decodeVaultState, type VaultStateView } from './chainState';
import { ownerFromState } from './coins';
import { POLICY_MAX_CU_CLAIM, POLICY_MAX_CU_PRICE } from './consts';
import { alert, cap, DAY, HOUR, limit, uncap, type Ctx } from './ctx';
import { manualReviewEnabled, programIdOf } from './env';
import { assertPlaceAllowed } from './geo';
import { isDevTestPlace, lookupContact, spendGoogleLookup, validPlaceId } from './google';
import { hmacHex } from './hmac';
import { ApiErr, CACHE, ID_RE, json, optStr, randomId, readJsonObject, str } from './http';
import { configView } from './meta';
import { notifyOwner } from './ownerAlerts';
import { getVerifier, phoneMode } from './phone';
import { approveClaim } from './policy';
import { referenceClaimViolations, warmReference } from './policyRef';
import { assertWalletAllowed } from './sanctions';
import { isConfirmed, txAccountKeys } from './solana';
import { verifyTurnstile } from './turnstile';
import { findOwnershipProof, isOwnSiteHost, multiTenantSuffix, websiteCode } from './website';
import {
  devTestPhoneFromHash,
  type ClaimCallResponse,
  type ClaimCheckResponse,
  type ClaimConfirmResponse,
  type ClaimCosignResponse,
  type ClaimStatusResponse,
  type ClaimWebsiteResponse,
} from './wire';

const CODE_TTL_MS = 10 * 60_000;
const TOKEN_TTL_MS = 30 * 60_000;
const RESEND_MS = 45_000;
const MAX_CALLS = 3;
const MAX_WRONG = 3;
const MAX_COSIGNS = 5;
const WEBSITE_TTL_MS = 2 * HOUR;
/** New website codes a day (each one is a paid Google contact lookup), per network and per shop. */
const WEBSITE_PER_IP_DAY = 10;
const WEBSITE_PER_PLACE_DAY = 20;

export interface ClaimRow {
  id: string;
  place_id: string;
  mint: string;
  method: 'call' | 'screen' | 'website' | 'manual';
  phone_hash: string | null;
  verify_ref: string | null;
  code_hash: string | null;
  status: 'calling' | 'verified' | 'cosigned' | 'pending_onchain' | 'finalized' | 'cancelled' | 'expired' | 'failed';
  calls: number;
  wrong_codes: number;
  cosign_count: number;
  token_hash: string | null;
  token_expires_at: number | null;
  new_owner: string | null;
  nonce: number | null;
  request_sig: string | null;
  unlock_ts: number | null;
  in_probation: number | null;
  website_host: string | null;
  requested_at: number;
  verified_at: number | null;
  last_call_at: number | null;
  expires_at: number;
  updated_at: number;
}

interface CoinBrief {
  place_id: string;
  mint: string;
  place_hash: string;
  vault_state: string;
  ticker: string;
  name: string;
  status: 'live' | 'hidden';
}

/** The place's coin, live OR hidden: a hidden coin's fees still belong to its verified owner. */
async function coinForPlace(ctx: Ctx, placeId: string): Promise<CoinBrief> {
  const c = await ctx.db
    .prepare('SELECT place_id, mint, place_hash, vault_state, ticker, name, status FROM coins WHERE place_id = ?1 AND cluster = ?2')
    .bind(placeId, ctx.cluster)
    .first<CoinBrief>();
  if (!c) throw new ApiErr('no_coin', 'This shop has no coin yet');
  return c;
}

async function readState(ctx: Ctx, vaultState: string): Promise<VaultStateView> {
  const acc = await ctx.rpc(2).getAccount(vaultState);
  if (!acc || !acc.data.length) throw new ApiErr('unavailable', 'The shop vault is not visible yet. Try again in a moment.');
  return decodeVaultState(acc.data);
}

/** Frees the one-active-claim index for a place: stale calling / verified / cosigned rows expire. */
async function expireStale(ctx: Ctx, placeId: string, now: number): Promise<void> {
  await ctx.db.batch([
    ctx.db.prepare("UPDATE claims SET status = 'expired', updated_at = ?2 WHERE place_id = ?1 AND status = 'calling' AND expires_at < ?2").bind(placeId, now),
    ctx.db
      .prepare("UPDATE claims SET status = 'expired', updated_at = ?2 WHERE place_id = ?1 AND status IN ('verified','cosigned') AND token_expires_at < ?2")
      .bind(placeId, now),
  ]);
}

function claimIdOf(body: Record<string, unknown>): string {
  const id = body.claimId;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new ApiErr('bad_request', 'Invalid claimId');
  return id;
}

async function loadClaim(ctx: Ctx, id: string): Promise<ClaimRow> {
  const c = await ctx.db.prepare('SELECT * FROM claims WHERE id = ?1').bind(id).first<ClaimRow>();
  if (!c) throw new ApiErr('not_found', 'Claim not found');
  return c;
}

/* ================================================================================================ status */

export async function handleClaimStatus(ctx: Ctx, url: URL): Promise<Response> {
  await limit(ctx.env.RL_READ, `read:${ctx.ipHash}`);
  const placeId = url.searchParams.get('placeId') ?? '';
  if (!validPlaceId(placeId, ctx.cluster)) throw new ApiErr('bad_request', 'Invalid placeId');
  const coin = await coinForPlace(ctx, placeId);
  const now = ctx.deps.now();
  const [state, active, cfg] = await Promise.all([
    readState(ctx, coin.vault_state),
    ctx.db
      .prepare("SELECT 1 AS x FROM claims WHERE place_id = ?1 AND method != 'website' AND ((status = 'calling' AND expires_at > ?2) OR (status IN ('verified','cosigned') AND token_expires_at > ?2)) LIMIT 1")
      .bind(placeId, now)
      .first(),
    configView(ctx),
  ]);
  const out: ClaimStatusResponse = {
    placeId,
    owner: ownerFromState(state),
    verificationActive: !!active,
    claimWindowSecs: cfg?.claimWindowSecs ?? 0,
    coin: { placeId: coin.place_id, mint: coin.mint, ticker: coin.ticker, name: coin.name, hidden: coin.status !== 'live' },
  };
  return json(out, 200, CACHE.none);
}

/* ================================================================================================== call */

interface PhoneTarget {
  e164: string;
  masked: string;
}

/**
 * DEVNET synthetic places (`cornershop-test:*`): a fictitious NANP number per place, `+1 <area> 555-01xx` (the 555-0100
 * to 555-0199 range is reserved for fiction), derived from the place id. Every test place therefore has its own
 * per-number cap, so testing one place never locks out the others. The screen verifier never calls anyone.
 */
export async function devTestPhone(placeId: string): Promise<PhoneTarget> {
  if (!__CS_DEV_ENDPOINTS__) throw new ApiErr('no_phone', 'This listing has no phone number on Google'); // compiled out
  return devTestPhoneFromHash(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(placeId))));
}

/** The listing's phone number. `paid` runs when a paid Google lookup is about to be made (the budget allowed it). */
async function phoneFor(ctx: Ctx, placeId: string, paid: () => void): Promise<PhoneTarget> {
  if (isDevTestPlace(placeId, ctx.cluster)) return devTestPhone(placeId);
  const c = await lookupContact(ctx.env, ctx.deps, placeId, async () => {
    await spendGoogleLookup(ctx);
    paid();
  });
  if (!c) throw new ApiErr('no_phone', 'This listing has no phone number on Google');
  assertPlaceAllowed(ctx.env, c.region, 'claim'); // worker/geo.ts
  if (!c.e164 || !c.display) throw new ApiErr('no_phone', 'This listing has no phone number on Google');
  if (isPremiumNumber(c.display)) throw new ApiErr('premium', "We can't call this number.");
  const masked = maskPhoneNumber(c.display);
  if (!masked) throw new ApiErr('no_phone', 'This listing has no phone number on Google');
  return { e164: c.e164, masked };
}

export async function handleClaimCall(ctx: Ctx, request: Request): Promise<Response> {
  await limit(ctx.env.RL_CLAIM, `claim:${ctx.ipHash}`, 20);
  const body = await readJsonObject(request);
  const placeId = body.placeId;
  if (!validPlaceId(placeId, ctx.cluster)) throw new ApiErr('bad_request', 'Invalid placeId');
  const mode = phoneMode(ctx.env, ctx.cluster);
  if (mode === 'none') throw new ApiErr('not_configured', "Phone verification isn't available yet");
  const now = ctx.deps.now();
  const coin = await coinForPlace(ctx, placeId);
  const state = await readState(ctx, coin.vault_state);
  if (state.pendingOwner) {
    throw new ApiErr('claim_pending', `A claim for this shop is in its public window until ${new Date((state.unlockTs ?? 0) * 1000).toISOString()}.`, {
      retryAfterSec: Math.max(1, (state.unlockTs ?? 0) - Math.floor(now / 1000)),
    });
  }
  await verifyTurnstile(ctx.env, ctx.deps, optStr(body, 'turnstileToken', 2048));

  const resendId = body.claimId === undefined ? null : claimIdOf(body);
  let claim: ClaimRow | null = null;
  if (resendId) {
    claim = await loadClaim(ctx, resendId);
    if (claim.place_id !== placeId || claim.status !== 'calling' || claim.expires_at < now || (claim.method !== 'call' && claim.method !== 'screen')) {
      throw new ApiErr('claim_expired', 'This verification expired. Start again.');
    }
    if (claim.calls >= MAX_CALLS) throw new ApiErr('too_many_attempts', 'No more calls for this claim. Try again later.', { retryAfterSec: 600 });
    if ((claim.last_call_at ?? 0) + RESEND_MS > now) {
      throw new ApiErr('too_many_attempts', 'Wait a moment before calling again.', { retryAfterSec: Math.ceil(((claim.last_call_at ?? 0) + RESEND_MS - now) / 1000) });
    }
  } else {
    await expireStale(ctx, placeId, now);
    const active = await ctx.db
      .prepare("SELECT expires_at, token_expires_at, status FROM claims WHERE place_id = ?1 AND status IN ('calling','verified','cosigned') AND method != 'website'")
      .bind(placeId)
      .first<{ expires_at: number; token_expires_at: number | null; status: string }>();
    if (active) {
      const until = active.status === 'calling' ? active.expires_at : (active.token_expires_at ?? now + 600_000);
      throw new ApiErr('claim_active', 'Someone is verifying this shop right now. Try again in 10 minutes.', { retryAfterSec: Math.min(600, Math.max(1, Math.ceil((until - now) / 1000))) });
    }
  }

  // Durable caps: 5/h per IP and 6/day per place, taken BEFORE the paid contact lookup they bound (it also spends the
  // global Google budget); then 3/day per number (rolling 24 h), which needs the number. A refused or failed attempt
  // gives the IP / place counts back, unless it already paid for a lookup: those are what the caps are for.
  let paid = false;
  const held: string[] = [];
  const release = async () => {
    if (!paid) await Promise.all(held.map((k) => uncap(ctx.db, k, k.startsWith('claim:ip:') ? HOUR : DAY, now).catch(() => undefined)));
  };
  const take = async (key: string, max: number, windowMs: number, message: string) => {
    try {
      await cap(ctx.db, key, max, windowMs, now, 'too_many_attempts', message);
    } catch (e) {
      if (e instanceof ApiErr) held.push(key); // the refusal counted this attempt too
      throw e;
    }
    held.push(key);
  };
  let phone: PhoneTarget;
  let phoneHash: string;
  try {
    await take(`claim:ip:${ctx.ipHash}`, 5, HOUR, 'Too many attempts from your network.');
    await take(`claim:place:${placeId}`, 6, DAY, 'Too many attempts for this shop today.');
    phone = await phoneFor(ctx, placeId, () => (paid = true));
    phoneHash = await hmacHex(ctx.env, 'phone', phone.e164);
    const recent = (
      await ctx.db
        .prepare("SELECT ts FROM phone_verifications WHERE phone_hash = ?1 AND ts > ?2 AND outcome = 'started' ORDER BY ts DESC LIMIT 3")
        .bind(phoneHash, now - DAY)
        .all<{ ts: number }>()
    ).results;
    if (recent.length >= 3) {
      // the number frees up when the 3rd most recent call leaves the 24 h window
      const retryAfterSec = Math.max(1, Math.ceil((recent[2]!.ts + DAY - now) / 1000));
      throw new ApiErr('too_many_attempts', 'Too many calls to this number today.', { retryAfterSec });
    }
  } catch (e) {
    await release();
    throw e;
  }

  const id = claim?.id ?? randomId();
  let started: Awaited<ReturnType<Awaited<ReturnType<typeof getVerifier>>['start']>>;
  let verifier: Awaited<ReturnType<typeof getVerifier>>;
  try {
    verifier = await getVerifier(ctx.env, ctx.deps, ctx.cluster);
    started = await verifier.start(phone.e164, { claimId: id });
  } catch (e) {
    await release();
    throw e;
  }
  const method = verifier.kind === 'screen' ? 'screen' : 'call';
  const calls = (claim?.calls ?? 0) + 1;
  const expiresAt = now + CODE_TTL_MS;
  try {
    await ctx.db.batch([
      claim
        ? ctx.db
            .prepare('UPDATE claims SET calls = ?2, last_call_at = ?3, verify_ref = ?4, code_hash = ?5, expires_at = ?6, updated_at = ?3 WHERE id = ?1')
            .bind(id, calls, now, started.ref, started.codeHash ?? null, expiresAt)
        : ctx.db
            .prepare(
              `INSERT INTO claims(id, place_id, mint, method, phone_hash, verify_ref, code_hash, status, calls, requested_at, last_call_at, expires_at, updated_at, ip_hash)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'calling', 1, ?8, ?8, ?9, ?8, ?10)`,
            )
            .bind(id, placeId, coin.mint, method, phoneHash, started.ref, started.codeHash ?? null, now, expiresAt, ctx.ipHash),
      ctx.db.prepare("INSERT INTO phone_verifications(phone_hash, ts, place_id, claim_id, outcome) VALUES (?1, ?2, ?3, ?4, 'started')").bind(phoneHash, now, placeId, id),
    ]);
  } catch (e) {
    await release();
    if (/UNIQUE/i.test(String(e))) throw new ApiErr('claim_active', 'Someone is verifying this shop right now. Try again in 10 minutes.', { retryAfterSec: 600 });
    throw e;
  }
  ctx.log.info('claim.call', { claim: id, method, calls });
  const out: ClaimCallResponse = {
    claimId: id,
    channel: verifier.kind,
    masked: phone.masked,
    expiresAt,
    resendAfterSec: RESEND_MS / 1000,
    callsLeft: Math.max(0, MAX_CALLS - calls),
  };
  if (__CS_DEV_ENDPOINTS__) {
    // DEVNET ONLY: the on-screen code (the whole block is compiled out of mainnet bundles)
    if (ctx.cluster === 'devnet' && verifier.kind === 'screen' && started.devCode) out.devCode = started.devCode;
  }
  return json(out, 200);
}

/* ================================================================================================= check */

async function issueToken(ctx: Ctx, id: string, now: number, extraSql = ''): Promise<{ token: string; expiresAt: number }> {
  const token = toB64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await hmacHex(ctx.env, 'tok', token);
  const expiresAt = now + TOKEN_TTL_MS;
  // only a claim that is still verifying can be verified (a parallel request may have failed or expired it)
  const res = await ctx.db
    .prepare(`UPDATE claims SET status = 'verified', token_hash = ?2, token_expires_at = ?3, verified_at = ?4, updated_at = ?4${extraSql} WHERE id = ?1 AND status = 'calling'`)
    .bind(id, tokenHash, expiresAt, now)
    .run();
  if (!res.meta?.changes) throw new ApiErr('claim_expired', 'This verification expired. Start again.');
  return { token, expiresAt };
}

export async function handleClaimCheck(ctx: Ctx, request: Request): Promise<Response> {
  await limit(ctx.env.RL_CLAIM, `claim:${ctx.ipHash}`, 20);
  const body = await readJsonObject(request);
  const id = claimIdOf(body);
  const code = typeof body.code === 'string' ? body.code.replace(/\s+/g, '') : '';
  if (!/^\d{6}$/.test(code)) throw new ApiErr('bad_request', 'The code has 6 digits');
  const now = ctx.deps.now();
  const c = await loadClaim(ctx, id);
  if (c.status !== 'calling' || c.expires_at < now || (c.method !== 'call' && c.method !== 'screen')) {
    throw new ApiErr('claim_expired', 'This code expired. Ask for a new call.');
  }
  if (c.wrong_codes >= MAX_WRONG) throw new ApiErr('too_many_attempts', 'Too many wrong codes. Start again later.', { retryAfterSec: 600 });
  const verifier = await getVerifier(ctx.env, ctx.deps, ctx.cluster);
  if ((c.method === 'screen') !== (verifier.kind === 'screen')) throw new ApiErr('claim_expired', 'This code expired. Ask for a new call.');
  // Take one of the MAX_WRONG attempts ATOMICALLY before the code is evaluated, so parallel checks can never evaluate
  // more than MAX_WRONG codes; a correct code gives its attempt back.
  const slot = await ctx.db
    .prepare("UPDATE claims SET wrong_codes = wrong_codes + 1, updated_at = ?2 WHERE id = ?1 AND status = 'calling' AND wrong_codes < ?3 RETURNING wrong_codes")
    .bind(id, now, MAX_WRONG)
    .first<{ wrong_codes: number }>();
  if (!slot) throw new ApiErr('too_many_attempts', 'Too many wrong codes. Start again later.', { retryAfterSec: 600 });
  let res: Awaited<ReturnType<typeof verifier.check>>;
  try {
    res = await verifier.check(c.verify_ref ?? '', '', code, { claimId: c.id, codeHash: c.code_hash });
  } catch (e) {
    // the code was never evaluated (verifier unreachable): give the attempt back
    await ctx.db.prepare("UPDATE claims SET wrong_codes = MAX(0, wrong_codes - 1) WHERE id = ?1 AND status = 'calling'").bind(id).run();
    throw e;
  }
  if (res === 'approved') {
    const t = await issueToken(ctx, id, now, ', wrong_codes = MAX(0, wrong_codes - 1)');
    await ctx.db
      .prepare("INSERT INTO phone_verifications(phone_hash, ts, place_id, claim_id, outcome) VALUES (?1, ?2, ?3, ?4, 'approved')")
      .bind(c.phone_hash ?? '', now, c.place_id, id)
      .run();
    ctx.log.info('claim.verified', { claim: id });
    // the claim co-sign follows: evaluate web3.js now, after this response, not on the co-sign's critical path
    if (ctx.env.POLICY_REFERENCE !== '0') ctx.waitUntil(warmReference());
    return json({ approved: true, claimToken: t.token, tokenExpiresAt: t.expiresAt } satisfies ClaimCheckResponse, 200);
  }
  if (res === 'expired') {
    await ctx.db.prepare("UPDATE claims SET status = 'expired', updated_at = ?2 WHERE id = ?1").bind(id, now).run();
    throw new ApiErr('claim_expired', 'This code expired. Ask for a new call.');
  }
  const wrong = slot.wrong_codes;
  const dead = wrong >= MAX_WRONG || res === 'max_attempts';
  if (dead) {
    await ctx.db.batch([
      ctx.db.prepare("UPDATE claims SET status = 'failed', updated_at = ?2 WHERE id = ?1 AND status = 'calling'").bind(id, now),
      ctx.db.prepare("INSERT INTO phone_verifications(phone_hash, ts, place_id, claim_id, outcome) VALUES (?1, ?2, ?3, ?4, 'failed')").bind(c.phone_hash ?? '', now, c.place_id, id),
    ]);
  }
  return json({ approved: false, attemptsLeft: dead ? 0 : MAX_WRONG - wrong } satisfies ClaimCheckResponse, 200);
}

/* ================================================================================================ cosign */

async function verifiedClaim(ctx: Ctx, body: Record<string, unknown>, now: number): Promise<ClaimRow> {
  const id = claimIdOf(body);
  const token = str(body, 'claimToken', 100);
  const c = await loadClaim(ctx, id);
  if (c.status !== 'verified' && c.status !== 'cosigned') throw new ApiErr('claim_not_verified', 'Verify the phone code first');
  if (!c.token_hash || !c.token_expires_at || c.token_expires_at < now) throw new ApiErr('claim_expired', 'This verification expired. Start again.');
  const h = await hmacHex(ctx.env, 'tok', token);
  if (!timingSafeEq(fromHex(h), fromHex(c.token_hash))) throw new ApiErr('claim_not_verified', 'Verify the phone code first');
  return c;
}

export async function handleClaimCosign(ctx: Ctx, request: Request): Promise<Response> {
  await limit(ctx.env.RL_CLAIM, `claim:${ctx.ipHash}`, 20);
  const body = await readJsonObject(request);
  const now = ctx.deps.now();
  const c = await verifiedClaim(ctx, body, now);
  if (c.cosign_count >= MAX_COSIGNS) throw new ApiErr('too_many_attempts', 'Too many attempts for this claim. Start again.', { retryAfterSec: 60 });
  const newOwner = canonicalPubkey(body.newOwner);
  if (!newOwner) throw new ApiErr('bad_request', 'Invalid newOwner');
  assertWalletAllowed(ctx, newOwner, 'claim payout');
  if (c.new_owner && c.new_owner !== newOwner) throw new ApiErr('wrong_owner', 'Use the wallet you started this claim with');
  let bytes: Uint8Array;
  try {
    if (typeof body.messageBase64 !== 'string' || body.messageBase64.length > 2_000) throw new Error('bad');
    bytes = fromB64(body.messageBase64);
  } catch {
    throw new ApiErr('bad_request', 'Invalid messageBase64');
  }
  if (ctx.env.POLICY_REFERENCE !== '0') void warmReference();
  const programId = programIdOf(ctx.env);
  // Config, attestor and the VaultState in parallel (each read is independent; the checks keep their order)
  const addrsP = placeAddresses(c.place_id, programId);
  const [cfg, attestor, addrs, stateOrErr] = await Promise.all([
    configView(ctx, { fresh: true }),
    attestorPubkey(ctx.env),
    addrsP,
    addrsP.then((a) => readState(ctx, a.vaultState)).then(
      (v) => ({ v }),
      (e: unknown) => ({ e }),
    ),
  ]);
  if (!cfg || !attestor || cfg.attestor !== attestor) throw new ApiErr('unavailable', 'Claims are not available right now');
  if (newOwner === cfg.attestor || newOwner === cfg.guardian || newOwner === cfg.governance) throw new ApiErr('wrong_owner', 'This wallet cannot own a shop');
  if ('e' in stateOrErr) throw stateOrErr.e;
  const state = stateOrErr.v;
  if (state.pendingOwner) throw new ApiErr('claim_pending', 'A claim for this shop is already in its public window.');
  if (state.owner === newOwner) throw new ApiErr('already_owner', 'This wallet already owns the shop');
  const expectedNonce = state.claimNonce + 1n;
  const reference = (b: Uint8Array) =>
    referenceClaimViolations(b, {
      attestor,
      newOwner,
      placeId: c.place_id,
      expectedNonce,
      maxComputeUnitLimit: POLICY_MAX_CU_CLAIM,
      maxComputeUnitPriceMicroLamports: POLICY_MAX_CU_PRICE,
      programId,
    });
  const approval = await approveClaim(
    bytes,
    {
      programId,
      attestor,
      newOwner,
      config: await configPda(programId),
      vaultState: addrs.vaultState,
      expectedNonce,
      maxComputeUnitLimit: POLICY_MAX_CU_CLAIM,
      maxComputeUnitPriceMicroLamports: POLICY_MAX_CU_PRICE,
    },
    ctx.env.POLICY_REFERENCE === '0' ? undefined : reference,
  );
  await ctx.db
    .prepare('UPDATE claims SET cosign_count = cosign_count + 1, new_owner = COALESCE(new_owner, ?2), updated_at = ?3 WHERE id = ?1')
    .bind(c.id, newOwner, now)
    .run();
  if (!approval.ok) {
    ctx.log.warn('claim.policy_violation', { claim: c.id, count: approval.violations.length, first: approval.violations[0] ?? '' });
    throw new ApiErr('policy_violation', "We couldn't approve this transaction. Please try again.", { violations: approval.violations.slice(0, 20) });
  }
  const { signature, attestor: signer } = await signApproved(ctx.env, approval.approved);
  await ctx.db.prepare("UPDATE claims SET status = 'cosigned', nonce = ?2, updated_at = ?3 WHERE id = ?1").bind(c.id, Number(expectedNonce), now).run();
  ctx.log.info('claim.cosigned', { claim: c.id, nonce: Number(expectedNonce) });
  // Every on-chain request_claim needs this co-sign, and the claimant may send it through any RPC and never call
  // /api/claim/confirm: the owner hears about it here, whatever happens next (once a day per place, nonce and wallet).
  ctx.waitUntil(
    notifyOwner(ctx, {
      kind: 'claim_cosigned',
      placeId: c.place_id,
      method: c.method,
      newOwner,
      previousOwner: state.owner && state.owner !== newOwner ? state.owner : null,
      nonce: Number(expectedNonce),
      websiteHost: c.website_host,
    }),
  );
  const out: ClaimCosignResponse = { attestor: signer, attestorSignature: toB64(signature), expectedNonce: expectedNonce.toString() };
  return json(out, 200);
}

/* =============================================================================================== confirm */

export async function handleClaimConfirm(ctx: Ctx, request: Request): Promise<Response> {
  await limit(ctx.env.RL_READ, `read:${ctx.ipHash}`);
  const body = await readJsonObject(request);
  const id = claimIdOf(body);
  const sig = isSignature(body.signature) ? (body.signature as string) : null;
  if (!sig) throw new ApiErr('bad_request', 'Invalid signature');
  const c = await loadClaim(ctx, id);
  const cfg = await configView(ctx);
  const windowSecs = cfg?.claimWindowSecs ?? 0;
  if (c.status === 'pending_onchain' || c.status === 'finalized') {
    return json({ status: 'pending_onchain', unlockTs: c.unlock_ts ?? 0, inProbation: !!c.in_probation, claimWindowSecs: windowSecs } satisfies ClaimConfirmResponse, 200);
  }
  if (c.status !== 'cosigned' || !c.new_owner || c.nonce === null) throw new ApiErr('claim_not_verified', 'This claim was not approved');
  const rpc = ctx.rpc(4);
  const st = await rpc.getSignatureStatus(sig);
  if (st?.err) throw new ApiErr('not_confirmed', 'The claim transaction failed on Solana.');
  if (!isConfirmed(st)) return json({ status: 'pending' } satisfies ClaimConfirmResponse, 202);
  const { vaultState } = await placeAddresses(c.place_id, programIdOf(ctx.env));
  const tx = await rpc.getTransaction(sig);
  if (!tx || !tx.meta) return json({ status: 'pending' } satisfies ClaimConfirmResponse, 202);
  if (!txAccountKeys(tx).includes(vaultState)) throw new ApiErr('not_confirmed', 'That transaction is not this claim.');
  const acc = await rpc.getAccount(vaultState);
  if (!acc) return json({ status: 'pending' } satisfies ClaimConfirmResponse, 202);
  const state = decodeVaultState(acc.data);
  if (state.pendingOwner !== c.new_owner || state.claimNonce !== BigInt(c.nonce)) throw new ApiErr('not_confirmed', 'The claim is not pending on-chain.');
  const now = ctx.deps.now();
  await ctx.db.batch([
    ctx.db
      .prepare("UPDATE claims SET status = 'pending_onchain', request_sig = ?2, unlock_ts = ?3, in_probation = ?4, onchain_at = ?5, updated_at = ?5 WHERE id = ?1")
      .bind(id, sig, state.unlockTs, state.inProbation ? 1 : 0, now),
    ctx.db
      .prepare('UPDATE coins SET pending_owner = ?2, unlock_ts = ?3, in_probation = ?4, claim_nonce = ?5, vault_at = ?6 WHERE place_id = ?1')
      .bind(c.place_id, state.pendingOwner, state.unlockTs, state.inProbation ? 1 : 0, Number(state.claimNonce), now),
  ]);
  ctx.log.info('claim.pending_onchain', { claim: id, unlockTs: state.unlockTs ?? 0 });
  // Every claim alerts the site owner. A website code (or any re-claim of an owned shop) is a weaker proof than a call
  // to the listing's phone, so that alert asks for a human check before the window ends (SPEC §8.6).
  ctx.waitUntil(
    notifyOwner(ctx, {
      kind: 'claim',
      placeId: c.place_id,
      method: c.method,
      newOwner: c.new_owner,
      previousOwner: state.owner && state.owner !== c.new_owner ? state.owner : null,
      nonce: Number(state.claimNonce),
      unlockTs: state.unlockTs,
      inProbation: state.inProbation,
      sig,
      websiteHost: c.website_host,
    }),
  );
  return json({ status: 'pending_onchain', unlockTs: state.unlockTs ?? 0, inProbation: state.inProbation, claimWindowSecs: windowSecs } satisfies ClaimConfirmResponse, 200);
}

/* =============================================================================================== website */

export async function handleClaimWebsite(ctx: Ctx, request: Request): Promise<Response> {
  if (ctx.env.FEATURE_WEBSITE_VERIFY !== '1') throw new ApiErr('not_enabled', 'Website verification is not enabled');
  await limit(ctx.env.RL_CLAIM, `claim:${ctx.ipHash}`, 20);
  const body = await readJsonObject(request);
  const placeId = body.placeId;
  if (!validPlaceId(placeId, ctx.cluster)) throw new ApiErr('bad_request', 'Invalid placeId');
  const now = ctx.deps.now();
  const coin = await coinForPlace(ctx, placeId);
  if (body.claimId === undefined) {
    if (isDevTestPlace(placeId, ctx.cluster)) throw new ApiErr('not_own_domain', 'This listing has no website of its own');
    // The caps and the global Google budget come BEFORE the paid lookup (phone + website: Enterprise SKU, never cached),
    // so a repeated or refused request never bills Google. Refused before Google was called: nothing is used up.
    const taken: string[] = [];
    let contact: Awaited<ReturnType<typeof lookupContact>>;
    try {
      for (const [key, max, message] of [
        [`website:ip:${ctx.ipHash}`, WEBSITE_PER_IP_DAY, 'Too many attempts from your network today.'],
        [`website:place:${placeId}`, WEBSITE_PER_PLACE_DAY, 'Too many attempts for this shop today.'],
      ] as const) {
        taken.push(key); // cap() counts a refused attempt too
        await cap(ctx.db, key, max, DAY, now, 'too_many_attempts', message);
      }
      contact = await lookupContact(ctx.env, ctx.deps, placeId, () => spendGoogleLookup(ctx));
    } catch (e) {
      if (e instanceof ApiErr && (e.code === 'too_many_attempts' || e.code === 'rate_limited')) {
        await Promise.all(taken.map((k) => uncap(ctx.db, k, DAY, now).catch(() => undefined)));
      }
      throw e;
    }
    assertPlaceAllowed(ctx.env, contact?.region, 'claim'); // worker/geo.ts
    let host: string | null = null;
    try {
      // keep the host exactly as listed (many sites only answer on www.); redirects may move within the registrable domain
      host = contact?.websiteUri ? new URL(contact.websiteUri).hostname.toLowerCase() : null;
    } catch {
      host = null;
    }
    if (!host || !isOwnSiteHost(host)) throw new ApiErr('not_own_domain', 'This listing has no website of its own');
    const state = await readState(ctx, coin.vault_state);
    if (state.pendingOwner) throw new ApiErr('claim_pending', 'A claim for this shop is already in its public window.');
    await expireStale(ctx, placeId, now);
    const id = randomId();
    const code = websiteCode();
    try {
      await ctx.db
        .prepare(
          `INSERT INTO claims(id, place_id, mint, method, verify_ref, website_host, status, calls, requested_at, last_call_at, expires_at, updated_at, ip_hash)
           VALUES (?1, ?2, ?3, 'website', ?4, ?5, 'calling', 0, ?6, ?6, ?7, ?6, ?8)`,
        )
        .bind(id, placeId, coin.mint, code, host, now, now + WEBSITE_TTL_MS, ctx.ipHash)
        .run();
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) throw new ApiErr('claim_active', 'Someone is verifying this shop right now. Try again later.', { retryAfterSec: 600 });
      throw e;
    }
    return json({ status: 'code', claimId: id, code, host } satisfies ClaimWebsiteResponse, 200);
  }
  const id = claimIdOf(body);
  const c = await loadClaim(ctx, id);
  if (c.place_id !== placeId || c.method !== 'website' || c.status !== 'calling' || c.expires_at < now || !c.website_host || !c.verify_ref) {
    throw new ApiErr('claim_expired', 'This verification expired. Start again.');
  }
  if ((c.last_call_at ?? 0) + 10_000 > now && c.calls > 0) throw new ApiErr('too_many_attempts', 'Wait a few seconds before checking again.', { retryAfterSec: 10 });
  await ctx.db.prepare('UPDATE claims SET calls = calls + 1, last_call_at = ?2, updated_at = ?2 WHERE id = ?1').bind(id, now).run();
  // Only places the site's owner controls prove ownership (SECURITY): a plain-text /.well-known/atlaspad.txt (or the
  // legacy cornershop.txt), or an atlaspad-verify (or cornershop-verify) meta tag in the home page's <head>. The code
  // appearing anywhere else (reviews, comments, a guestbook) never counts.
  const proof = await findOwnershipProof(ctx.deps, c.website_host, c.verify_ref);
  if (proof) {
    const t = await issueToken(ctx, id, now);
    ctx.log.info('claim.website_verified', { claim: id, proof });
    // Sent (warn): a website code is the weaker proof and the only claim method on mainnet, so the owner hears about it
    // at each step: verified (here), co-signed, and pending on-chain (claim confirm, the program monitor or the vault
    // sweep), the last with the claimant's wallet and the unlock time. One per claim (ref = claim id).
    const tenant = multiTenantSuffix(c.website_host);
    const check = tenant ? `; multi-tenant host (${tenant}): check the subdomain is the business's own` : '';
    ctx.waitUntil(alert(ctx, 'warn', 'claim_website_verified', `Website-code claim ${id} verified for place ${placeId} (${c.website_host}, ${proof})${check}`, id));
    return json({ status: 'approved', claimId: id, claimToken: t.token, tokenExpiresAt: t.expiresAt } satisfies ClaimWebsiteResponse, 200);
  }
  return json({ status: 'not_found', claimId: id } satisfies ClaimWebsiteResponse, 200);
}

/* ============================================================================================ report / manual */

const REPORT_REASON_RE = /^[A-Za-z][A-Za-z0-9 _-]{1,59}$/;

export async function handleReport(ctx: Ctx, request: Request, kindOverride?: 'manual_claim'): Promise<Response> {
  await limit(ctx.env.RL_WRITE, `write:${ctx.ipHash}`);
  const body = await readJsonObject(request);
  const kind = kindOverride ?? body.kind;
  if (kind !== 'report' && kind !== 'optout' && kind !== 'manual_claim') throw new ApiErr('bad_request', 'Invalid kind');
  // manual review stays closed until its tooling exists (FEATURE_MANUAL_REVIEW; default off on mainnet)
  if (kind === 'manual_claim' && !manualReviewEnabled(ctx.env, ctx.cluster)) throw new ApiErr('not_enabled', 'Manual review is not available yet');
  const reason = str(body, 'reason', 60);
  if (!REPORT_REASON_RE.test(reason)) throw new ApiErr('bad_request', 'Invalid reason');
  const placeId = optStr(body, 'placeId', 300);
  if (placeId && !validPlaceId(placeId, ctx.cluster)) throw new ApiErr('bad_request', 'Invalid placeId');
  const mintRaw = optStr(body, 'mint', 300);
  // "Coin link or mint": accept a bare mint or a URL that ends with one
  const mint = mintRaw ? canonicalPubkey(mintRaw.trim().split(/[/?#=]/).filter(Boolean).pop() ?? '') : null;
  if (mintRaw && !mint) throw new ApiErr('bad_request', 'Enter a coin link or mint address');
  if (!placeId && !mint) throw new ApiErr('bad_request', 'Say which coin or shop this is about');
  const details = optStr(body, 'details', 1000) ?? null;
  const contact = optStr(body, 'contact', 200) ?? null;
  const wallet = kind === 'manual_claim' && body.wallet !== undefined ? canonicalPubkey(body.wallet) : null;
  if (kind === 'manual_claim' && body.wallet !== undefined && !wallet) throw new ApiErr('bad_request', 'Invalid wallet');
  const now = ctx.deps.now();
  await cap(ctx.db, `report:ip:${ctx.ipHash}`, 20, DAY, now, 'rate_limited', 'Too many reports today. Try again tomorrow.');
  await ctx.db
    .prepare('INSERT INTO reports(kind, place_id, mint, reason, details, contact, created_at, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
    .bind(kind, placeId ?? null, mint, reason, details, contact, now, ctx.ipHash)
    .run();
  ctx.log.info('report.stored', { kind, reason });
  ctx.waitUntil(notifyOwner(ctx, { kind, placeId: placeId ?? null, mint, reason, wallet }));
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}
