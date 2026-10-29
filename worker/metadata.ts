/**
 * Coin metadata + art (INTEGRATION §3.3). `POST /api/metadata` validates and stores the image and a SERVER-BUILT
 * metadata JSON in D1 (content-addressed, read-after-write consistent — pump.fun and wallets fetch the URI seconds
 * after a launch); `/meta/<id>.json` and `/img/<id>.<ext>` serve them immutable.
 */
import { toHex, utf8 } from './bytes';
import { cap, DAY, limit, type Ctx } from './ctx';
import { withDisclaimer } from './disclaimer';
import { ApiErr, CACHE, json, readLimited } from './http';
import { EXT_TYPE, sniffImage, TYPE_EXT, type ImageType } from './images';
import { containsLink, containsUrl, hasInvisible, moderationHit } from './moderation';
import { validPlaceId } from './google';
import {
  DESCRIPTION_MAX_CHARS,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PX,
  IMAGE_TYPES,
  NAME_MAX_BYTES,
  TICKER_RE,
  URI_MAX_BYTES,
  type MetadataUploadResponse,
} from './wire';

const BODY_MAX = 260_000;
/** Uploads a day for the whole site (per cluster database); unused ones are deleted after 6 h (indexer retention). */
export const META_GLOBAL_PER_DAY = 400;

export async function sha256Hex(b: Uint8Array | string, bytes = 16): Promise<string> {
  const data = typeof b === 'string' ? utf8.encode(b) : b;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)).subarray(0, bytes));
}

/** NFC-normalised, trimmed name; throws bad_request with a user-facing reason. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ApiErr('bad_request', 'Enter a coin name');
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  const len = utf8.encode(name).length;
  if (len < 1) throw new ApiErr('bad_request', 'Enter a coin name');
  if (len > NAME_MAX_BYTES) throw new ApiErr('bad_request', `The name is too long (max ${NAME_MAX_BYTES} bytes)`);
  if (hasInvisible(name)) throw new ApiErr('bad_request', 'The name contains invisible characters');
  if (containsUrl(name)) throw new ApiErr('bad_request', 'Links are not allowed in the name');
  return name;
}

export function cleanSymbol(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim().replace(/^\$/, '') : '';
  if (!TICKER_RE.test(s)) throw new ApiErr('bad_request', 'Tickers are 2-8 capital letters or digits');
  return s;
}

export function cleanDescription(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new ApiErr('bad_request', 'Invalid description');
  const d = raw.normalize('NFC').trim();
  if ([...d].length > DESCRIPTION_MAX_CHARS) throw new ApiErr('bad_request', `The description is too long (max ${DESCRIPTION_MAX_CHARS})`);
  if (hasInvisible(d.replace(/\n/g, ' '))) throw new ApiErr('bad_request', 'The description contains invisible characters');
  // links in metadata are shown by wallets / pump.fun next to the shop's name: phishing vector (names refuse them too)
  if (containsLink(d)) throw new ApiErr('moderation', "Links aren't allowed in the description.");
  return d;
}

export async function handleMetadataUpload(ctx: Ctx, request: Request): Promise<Response> {
  await limit(ctx.env.RL_WRITE, `write:${ctx.ipHash}`);
  const len = Number(request.headers.get('content-length') ?? '0');
  if (len > BODY_MAX) throw new ApiErr('payload_too_large', 'The image is too large');
  const ct = request.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().startsWith('multipart/form-data')) throw new ApiErr('unsupported_media', 'Send multipart/form-data');
  const raw = await readLimited(request, BODY_MAX);
  let form: FormData;
  try {
    form = await new Response(raw, { headers: { 'content-type': ct } }).formData();
  } catch {
    throw new ApiErr('bad_request', 'Malformed form data');
  }
  const name = cleanName(form.get('name'));
  const symbol = cleanSymbol(form.get('symbol'));
  const description = cleanDescription(form.get('description'));
  const placeId = form.get('placeId');
  if (!validPlaceId(placeId, ctx.cluster)) throw new ApiErr('bad_request', 'Invalid placeId');
  const hit = moderationHit(name, symbol, description);
  if (hit) throw new ApiErr('moderation', "That name or description isn't allowed. Try another.");

  const file = form.get('image');
  if (!file || typeof file === 'string') throw new ApiErr('bad_request', 'Add an image');
  const declared = (file as File).type as ImageType;
  if (!(IMAGE_TYPES as readonly string[]).includes(declared)) throw new ApiErr('unsupported_media', 'Use a PNG, JPEG or WebP image');
  const bytes = new Uint8Array(await (file as File).arrayBuffer());
  if (bytes.length === 0) throw new ApiErr('bad_request', 'Add an image');
  if (bytes.length > IMAGE_MAX_BYTES) throw new ApiErr('payload_too_large', 'The image is too large (max 200 KB)');
  const info = sniffImage(bytes);
  if (!info || info.type !== declared) throw new ApiErr('unsupported_media', 'Use a PNG, JPEG or WebP image');
  if (info.width < 1 || info.height < 1 || info.width > IMAGE_MAX_PX || info.height > IMAGE_MAX_PX) {
    throw new ApiErr('bad_request', `The image must be at most ${IMAGE_MAX_PX}×${IMAGE_MAX_PX}`);
  }
  if (Math.abs(info.width - info.height) > Math.max(info.width, info.height) * 0.02) throw new ApiErr('bad_request', 'The image must be square');

  // durable daily caps only after the cheap checks (failed validations do not burn the quota): per IP, then one budget
  // for everyone, because uploads need no wallet and each stores up to ~200 KB in D1 (500 MB on Workers Free). Checked
  // after the per-IP cap so one IP over its own cap cannot use up the shared one; fails closed (a D1 error refuses).
  const now = ctx.deps.now();
  await cap(ctx.db, `meta:ip:${ctx.ipHash}`, 60, DAY, now, 'rate_limited', 'Too many uploads today. Try again tomorrow.');
  await cap(ctx.db, 'meta:global', META_GLOBAL_PER_DAY, DAY, now, 'rate_limited', 'Uploads are busy today. Try again tomorrow.');

  const imageId = await sha256Hex(bytes);
  const imageUrl = `${ctx.origin}/img/${imageId}.${TYPE_EXT[info.type]}`;
  const metaJson = JSON.stringify({
    name,
    symbol,
    // the on-chain-facing description always ends with the affiliation disclaimer (D1 keeps the launcher's own text)
    description: withDisclaimer(description),
    image: imageUrl,
    showName: true,
    createdOn: ctx.origin,
    website: `${ctx.origin}/p/${encodeURIComponent(placeId)}`,
  });
  const metadataId = await sha256Hex(metaJson);
  const uri = `${ctx.origin}/meta/${metadataId}.json`;
  if (utf8.encode(uri).length > URI_MAX_BYTES) throw new ApiErr('unavailable', 'Metadata URL too long for this origin');

  await ctx.db.batch([
    ctx.db
      // content-addressed: an identical re-upload refreshes created_at (at most hourly) so the 6 h retention keeps it
      .prepare(
        'INSERT INTO assets(id, content_type, bytes, width, height, created_at, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at WHERE assets.created_at < excluded.created_at - 3600000',
      )
      .bind(imageId, info.type, bytes, info.width, info.height, now, ctx.ipHash),
    ctx.db
      .prepare(
        'INSERT INTO metadata(id, json, name, symbol, description, image_id, place_id, created_at, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at WHERE metadata.created_at < excluded.created_at - 3600000',
      )
      .bind(metadataId, metaJson, name, symbol, description, imageId, placeId, now, ctx.ipHash),
  ]);
  ctx.log.info('metadata.stored', { metadataId, imageId, bytes: bytes.length });
  const out: MetadataUploadResponse = { metadataId, uri, imageUrl, name, symbol };
  return json(out, 200);
}

const IMMUTABLE_HEADERS = {
  'cache-control': CACHE.immutable,
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'",
  'access-control-allow-origin': '*',
  'cross-origin-resource-policy': 'cross-origin',
};

/** GET /meta/<32 hex>.json */
export async function serveMeta(db: D1Database, id: string, head: boolean): Promise<Response> {
  if (!/^[0-9a-f]{32}$/.test(id)) return new Response('Not found', { status: 404 });
  const row = await db.prepare('SELECT json FROM metadata WHERE id = ?1').bind(id).first<{ json: string }>();
  if (!row) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  return new Response(head ? null : row.json, { status: 200, headers: { ...IMMUTABLE_HEADERS, 'content-type': 'application/json; charset=utf-8' } });
}

/** GET /img/<32 hex>.<png|jpg|webp> */
export async function serveImage(db: D1Database, id: string, ext: string, head: boolean): Promise<Response> {
  const want = EXT_TYPE[ext];
  if (!/^[0-9a-f]{32}$/.test(id) || !want) return new Response('Not found', { status: 404 });
  const row = await db.prepare('SELECT content_type, bytes FROM assets WHERE id = ?1').bind(id).first<{ content_type: string; bytes: unknown }>();
  if (!row || row.content_type !== want) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const bytes = toBytes(row.bytes);
  return new Response(head ? null : bytes, { status: 200, headers: { ...IMMUTABLE_HEADERS, 'content-type': want, 'content-length': String(bytes.length) } });
}

/** D1 returns BLOBs as number[] / ArrayBuffer depending on the runtime version; normalise. */
export function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return new Uint8Array(0);
}
