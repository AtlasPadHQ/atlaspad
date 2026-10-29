/**
 * Devnet synthetic places: the claim modal's Verify step must show the same fictitious number the Worker reports from
 * its (simulated) call (QA round 2: the modal showed a made-up `+44 20 •••• ••00`). Both sides use
 * worker/wire.ts devTestPhoneFromHash over sha256(placeId); worker/e2e.test.ts checks the Worker's side.
 */
import { describe, expect, it } from 'vitest';
import { devTestPhoneFromHash } from '../../worker/wire';
import { devTestPhoneMasked } from './place';

const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

describe('devTestPhoneMasked', () => {
  it('is the Worker derivation over sha256(placeId)', async () => {
    for (const id of ['cornershop-test:v5vf-a1', 'cornershop-test:cafe-1', 'cornershop-test:a', 'cornershop-test:zzz-999']) {
      const h = await sha256(id);
      expect(await devTestPhoneMasked(id), id).toBe(devTestPhoneFromHash(h).masked);
    }
  });
  it('is a fictitious +1 555-01xx number, masked', async () => {
    expect(await devTestPhoneMasked('cornershop-test:v5vf-a1')).toMatch(/^\+1 [2-9]\d\d ••• ••\d\d$/);
    const h = await sha256('cornershop-test:v5vf-a1');
    expect(devTestPhoneFromHash(h).e164).toMatch(/^\+1[2-9]\d\d55501\d\d$/);
  });
});
