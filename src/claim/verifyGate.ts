/**
 * The real-mode claim modal's Verify screen, decided in one pure function (src/claim/RealClaimFlow.tsx renders it,
 * verifyGate.test.ts covers every case): what blocks the claim, which banner to show, and which primary action to offer.
 *
 * Phone verification can be off (mainnet starts without Twilio: /api/config phoneVerification 'none'). Then the
 * website code is the way in, with friendly copy; with no website of its own and no manual review either, there is no
 * way in yet: the owner is told so plainly and can email us to hear when there is (the fees stay in the vault). A coin
 * hidden from the map is known only from /api/claim/status, so nothing is decided before it.
 */

export const PHONE_OFF_COPY = "Phone check isn't switched on yet. Verify with a code on your website.";
export const CONTACT_EMAIL = 'hello@atlaspad.online';
export const NO_WAY_COPY = `Verification for shops without their own website isn't available yet. Email ${CONTACT_EMAIL} and we'll tell you when it is; this shop's fees stay safe in its vault.`;
export const NO_COIN_COPY = 'This shop has no coin yet. Launch one first — its fees then wait here for you.';

export interface VerifyInput {
  phoneMode: 'call' | 'screen' | 'none';
  /**
   * /api/claim/status answered (it also returns a coin hidden from the map), or said `no_coin`: either way it is known
   * whether the place has a coin.
   */
  statusReady: boolean;
  /** The place has a coin (in the app's lists, or from the claim status). */
  hasCoin: boolean;
  /** The coin is in the app's lists (known before the status answers). */
  coinInList: boolean;
  /** A claim is in its public window; `pendingText` says until when. */
  pending: boolean;
  pendingText: string | null;
  /** Someone else is verifying this place by phone right now. */
  verificationActive: boolean;
  contact: 'loading' | 'ready' | 'error' | 'limited';
  listingBlocked: 'no-phone' | 'premium' | null;
  /** The listing's masked phone number, when it has one. */
  masked: string | null;
  /** Website verification is on and the listing has a website of its own. */
  websiteWay: boolean;
  manualReview: boolean;
  /** The status or the listing lookup failed. */
  anyError: boolean;
}

export type VerifyAction = 'blocked' | 'email' | 'website' | 'other' | 'retry' | 'call';

export interface VerifyGate {
  /** Banner text, or null (no banner). */
  text: string | null;
  tone: 'amber' | 'neutral';
  icon: 'schedule' | 'info' | 'warning';
  /** Nothing can be started here (no coin, a pending claim, someone verifying, lookups limited). */
  hard: boolean;
  action: VerifyAction;
  /** 'website' only: still waiting for the listing's website (button loading). */
  waiting: boolean;
  /** The secondary text button: "Can't answer this number?" / "Other ways" / none. */
  link: 'cant-answer' | 'other-ways' | null;
}

export function verifyGate(i: VerifyInput): VerifyGate {
  const phoneOff = i.phoneMode === 'none';
  const noWayLeft = phoneOff && i.statusReady && i.hasCoin && i.contact === 'ready' && !i.websiteWay && !i.manualReview;
  let text: string | null = null;
  if (!i.statusReady && !i.coinInList) text = null; // a hidden coin is only known from the status: wait for it (or its error)
  else if (!i.hasCoin) text = NO_COIN_COPY;
  else if (i.pending && i.pendingText) text = i.pendingText;
  else if (i.verificationActive) text = 'Someone is verifying this shop right now. Try again in 10 minutes.';
  else if (i.contact === 'limited') text = 'Too many lookups right now. Try again later.';
  else if (phoneOff && i.anyError) text = null; // the lookup failed: its error banner and Try again, never a dead end
  else if (noWayLeft) text = NO_WAY_COPY;
  else if (phoneOff) text = PHONE_OFF_COPY;
  else if (i.contact === 'ready' && (i.listingBlocked === 'no-phone' || !i.masked)) text = 'This listing has no phone number. Choose another way to verify.';
  else if (i.contact === 'ready' && i.listingBlocked === 'premium') text = "We can't call this number. Choose another way to verify.";

  const hard = (!i.hasCoin && i.statusReady) || i.pending || i.verificationActive || i.contact === 'limited';
  let action: VerifyAction;
  if (hard) action = 'blocked';
  else if (noWayLeft) action = 'email';
  else if (phoneOff && i.statusReady && (i.websiteWay || i.contact === 'loading')) action = 'website';
  else if (text) action = 'other';
  else if (i.anyError) action = 'retry';
  else action = 'call';

  const friendly = phoneOff && !hard && !noWayLeft;
  return {
    text,
    tone: friendly ? 'neutral' : 'amber',
    icon: i.pending ? 'schedule' : phoneOff && !hard ? 'info' : 'warning',
    hard,
    action,
    waiting: action === 'website' && i.contact === 'loading',
    link: hard || noWayLeft ? null : !text && !phoneOff ? 'cant-answer' : action === 'website' && i.websiteWay && i.manualReview ? 'other-ways' : null,
  };
}
