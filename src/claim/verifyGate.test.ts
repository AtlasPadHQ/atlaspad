import { describe, expect, it } from 'vitest';
import { NO_COIN_COPY, NO_WAY_COPY, PHONE_OFF_COPY, verifyGate, type VerifyInput } from './verifyGate';

/** A launched, unclaimed shop with a callable listing and its own website; everything loaded. */
const ready: VerifyInput = {
  phoneMode: 'call',
  statusReady: true,
  hasCoin: true,
  coinInList: true,
  pending: false,
  pendingText: null,
  verificationActive: false,
  contact: 'ready',
  listingBlocked: null,
  masked: '+44 20 •••• ••23',
  websiteWay: true,
  manualReview: false,
  anyError: false,
};

describe('claim Verify screen', () => {
  it('phone verification on: call, with the "Can\'t answer" way out', () => {
    expect(verifyGate(ready)).toMatchObject({ text: null, action: 'call', hard: false, link: 'cant-answer' });
    expect(verifyGate({ ...ready, listingBlocked: 'premium' })).toMatchObject({ text: "We can't call this number. Choose another way to verify.", action: 'other' });
    expect(verifyGate({ ...ready, masked: null })).toMatchObject({ action: 'other', tone: 'amber', icon: 'warning' });
  });

  it('phone verification off (mainnet without Twilio): the website code first, with friendly copy', () => {
    const g = verifyGate({ ...ready, phoneMode: 'none' });
    expect(g).toEqual({ text: PHONE_OFF_COPY, tone: 'neutral', icon: 'info', hard: false, action: 'website', waiting: false, link: null });
    expect(PHONE_OFF_COPY).toBe("Phone check isn't switched on yet. Verify with a code on your website.");
    // manual review open (devnet): "Other ways" stays reachable
    expect(verifyGate({ ...ready, phoneMode: 'none', manualReview: true }).link).toBe('other-ways');
    // the listing is still loading: the website button waits for its host
    expect(verifyGate({ ...ready, phoneMode: 'none', contact: 'loading' })).toMatchObject({ action: 'website', waiting: true });
    // no website of its own and no manual review: email us
    expect(verifyGate({ ...ready, phoneMode: 'none', websiteWay: false })).toMatchObject({ text: NO_WAY_COPY, action: 'email', tone: 'amber', link: null });
    expect(NO_WAY_COPY).toContain('hello@atlaspad.online');
    // nothing can approve such a shop yet, so no promise of help verifying
    expect(NO_WAY_COPY).toBe(
      "Verification for shops without their own website isn't available yet. Email hello@atlaspad.online and we'll tell you when it is; this shop's fees stay safe in its vault.",
    );
    expect(NO_WAY_COPY).not.toMatch(/help you verify/);
    // ...but with manual review open, the other ways
    expect(verifyGate({ ...ready, phoneMode: 'none', websiteWay: false, manualReview: true })).toMatchObject({ text: PHONE_OFF_COPY, action: 'other' });
    // a failed listing lookup (no website known) or status: its error banner and Try again, never a dead-end "other ways"
    expect(verifyGate({ ...ready, phoneMode: 'none', contact: 'error', websiteWay: false, anyError: true })).toMatchObject({ text: null, action: 'retry', hard: false, link: null });
    expect(verifyGate({ ...ready, phoneMode: 'none', statusReady: false, anyError: true })).toMatchObject({ text: null, action: 'retry' });
  });

  it('hard blocks win: no coin, a pending claim, someone verifying, lookups limited', () => {
    // the status said no_coin (RealClaimFlow passes it as answered): "launch one first", not an error to retry
    expect(verifyGate({ ...ready, hasCoin: false, coinInList: false })).toMatchObject({ text: NO_COIN_COPY, hard: true, action: 'blocked', link: null });
    expect(verifyGate({ ...ready, phoneMode: 'none', hasCoin: false, coinInList: false, contact: 'error', anyError: true })).toMatchObject({ text: NO_COIN_COPY, action: 'blocked' });
    expect(verifyGate({ ...ready, phoneMode: 'none', pending: true, pendingText: 'A claim for this shop is in its public window until 1 Nov.' })).toMatchObject({
      text: 'A claim for this shop is in its public window until 1 Nov.',
      icon: 'schedule',
      tone: 'amber',
      action: 'blocked',
    });
    expect(verifyGate({ ...ready, verificationActive: true }).action).toBe('blocked');
    expect(verifyGate({ ...ready, contact: 'limited' }).action).toBe('blocked');
  });

  it('a coin hidden from the map is only known from the claim status: nothing is decided before it answers', () => {
    const loading = verifyGate({ ...ready, phoneMode: 'none', statusReady: false, hasCoin: false, coinInList: false });
    expect(loading).toMatchObject({ text: null, hard: false, link: null });
    expect(loading.action).not.toBe('website');
    // the status found the hidden coin: the owner can claim it like any other
    expect(verifyGate({ ...ready, coinInList: false })).toMatchObject({ text: null, action: 'call' });
    expect(verifyGate({ ...ready, phoneMode: 'none', coinInList: false }).action).toBe('website');
    // the status failed and the coin is not in the lists: retry, never "no coin yet"
    expect(verifyGate({ ...ready, statusReady: false, hasCoin: false, coinInList: false, anyError: true })).toMatchObject({ text: null, action: 'retry', hard: false });
  });
});
