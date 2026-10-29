/**
 * Front-end handling of the sanctions refusals (worker/geo.ts, worker/sanctions.ts): the fetch observer that turns a
 * 451 `region_blocked` into the blocking notice, the notice itself, and the inline copy launch / claim / trade flows
 * show for `place_region_blocked` and `wallet_blocked`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { RPC_WALLET_BLOCKED } from '../../worker/wire';
import { ApiError as ChainApiError, toTxError } from '../chain/errors';
import { RpcError } from '../chain/rpc';
import { ApiError, apiErrorMessage } from '../realdata/api';
import RegionBlocked, { CONTACT_EMAIL, REGION_BLOCKED_TITLE } from './RegionBlocked';
import { __resetRegionBlock, isRegionBlocked, markRegionBlocked, watchRegionBlock } from './regionBlock';

const ORIGIN = 'https://atlaspad.online';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => __resetRegionBlock());

describe('region_blocked observer', () => {
  it('a same-origin /api/* 451 region_blocked flips the flag; the caller still gets the untouched response', async () => {
    const f = watchRegionBlock(async () => json(451, { error: 'region_blocked', message: 'x' }), ORIGIN);
    expect(isRegionBlocked()).toBe(false);
    const res = await f('/api/market?mints=a');
    expect(isRegionBlocked()).toBe(true);
    expect(res.status).toBe(451);
    expect(await res.json()).toEqual({ error: 'region_blocked', message: 'x' });
  });

  it('works for absolute URLs and Request objects (the /api/rpc client posts to the full URL)', async () => {
    const f = watchRegionBlock(async () => json(451, { error: 'region_blocked' }), ORIGIN);
    await f(new Request(`${ORIGIN}/api/rpc`, { method: 'POST', body: '{}' }));
    expect(isRegionBlocked()).toBe(true);
    __resetRegionBlock();
    await f(new URL(`${ORIGIN}/api/config`));
    expect(isRegionBlocked()).toBe(true);
  });

  it('ignores everything else: other codes, other statuses, other origins, non-API paths, non-JSON', async () => {
    const cases: [string, Response][] = [
      ['/api/launch/prepare', json(451, { error: 'place_region_blocked' })],
      ['/api/claim/cosign', json(451, { error: 'wallet_blocked' })],
      ['/api/coins', json(403, { error: 'region_blocked' })],
      ['https://places.googleapis.com/api/x', json(451, { error: 'region_blocked' })],
      ['/p/abc', json(451, { error: 'region_blocked' })],
      ['/api/coins', new Response('<!doctype html>', { status: 451 })],
    ];
    for (const [url, res] of cases) {
      await watchRegionBlock(async () => res, ORIGIN)(url);
      expect(isRegionBlocked(), url).toBe(false);
    }
  });

  it('network errors pass straight through', async () => {
    const f = watchRegionBlock(async () => {
      throw new TypeError('Failed to fetch');
    }, ORIGIN);
    await expect(f('/api/coins')).rejects.toThrow('Failed to fetch');
    expect(isRegionBlocked()).toBe(false);
  });
});

describe('the blocking notice', () => {
  it('renders nothing until blocked, then the calm notice with Terms, Privacy and the contact address', () => {
    expect(renderToStaticMarkup(createElement(RegionBlocked))).toBe('');
    markRegionBlocked();
    const html = renderToStaticMarkup(createElement(RegionBlocked));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain(REGION_BLOCKED_TITLE.replace("'", '&#x27;'));
    expect(html).toContain(`mailto:${CONTACT_EMAIL}`);
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(CONTACT_EMAIL).toBe('hello@atlaspad.online');
  });

  it('is installed for the whole app in main.tsx', () => {
    const main = readFileSync(join(__dirname, '..', 'main.tsx'), 'utf8');
    expect(main).toMatch(/installRegionBlockWatch\(\);/);
    expect(main).toMatch(/<RegionBlocked \/>/);
  });
});

describe('inline copy for launch, claim and trade flows', () => {
  it('place_region_blocked → not-launchable with the server copy, no retry', () => {
    const e = toTxError(new ChainApiError(451, { error: 'place_region_blocked', message: "AtlasPad isn't available for businesses in this region." }), { sent: false });
    expect(e).toMatchObject({ code: 'not-launchable', retryable: false, message: "AtlasPad isn't available for businesses in this region." });
    expect(toTxError(new ChainApiError(451, { error: 'place_region_blocked' }), { sent: false }).message).toBe("AtlasPad isn't available for businesses in this region.");
  });

  it('wallet_blocked (co-sign) and RPC_WALLET_BLOCKED (send) → final wallet copy, nothing sent', () => {
    expect(toTxError(new ChainApiError(451, { error: 'wallet_blocked' }), { sent: false })).toMatchObject({ code: 'unknown', retryable: false, message: "This wallet can't be used on AtlasPad." });
    const rpc = toTxError(new RpcError(RPC_WALLET_BLOCKED, 'wallet blocked'), { sent: true });
    expect(rpc).toMatchObject({ retryable: false, sent: false, message: "This wallet can't be used on AtlasPad." });
    expect(toTxError(new ChainApiError(451, { error: 'region_blocked' }), { sent: false }).message).toBe("AtlasPad isn't available in your region.");
  });

  it('claim screens (apiErrorMessage) say the same', () => {
    expect(apiErrorMessage(new ApiError(451, { error: 'place_region_blocked' }))).toBe("AtlasPad isn't available for businesses in this region.");
    expect(apiErrorMessage(new ApiError(451, { error: 'wallet_blocked' }))).toBe("This wallet can't be used on AtlasPad.");
    expect(apiErrorMessage(new ApiError(451, { error: 'region_blocked' }))).toBe("AtlasPad isn't available in your region.");
  });
});
