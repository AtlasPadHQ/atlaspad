/**
 * Claim modal — phone-call verification (DESIGN §12.3, BRIEF "Owner claim"):
 *   Verify (masked listed number, looked up server-side) → Code (simulated call, demo code
 *   482 913, 3 tries, 45s call-again cooldown) → Payout (connected wallet or a pasted base58
 *   address, 72-hour hold, owner checkbox) → Done.
 * Other ways to verify: code on the listing's website, email at its domain (both continue to
 * Payout), manual review (ends in "We'll review your claim" + claim pending).
 * Owners reopen it at Payout ("Payout settings" / "Payouts") to change the payout wallet.
 * Renders when store.modal?.kind === 'claim'. Contract: default export, no props.
 * Prototype: no call, email or transaction is ever made.
 */
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { DEMO_CLAIM_CODE, RESEND_COOLDOWN_S } from '../config';
import { getDemoPlace } from '../lib/demoBridge';
import { copyText } from '../lib/clipboard';
import { isValidSolanaAddress } from '../lib/fakeSolana';
import { countdown, maskPhone, shortAddr, solApprox, usdFull } from '../lib/format';
import { googlePlaceStub, placeFromCoin, sourceFromId } from '../lib/place';
import { hashString } from '../lib/rand';
import { DemoPlaceCompact } from '../panel/PlaceBlocks';
import { GooglePlaceCompact } from '../panel/GoogleBlock';
import { getListedPhoneMasked } from '../places';
import { feesWaiting, isOwner, isOwnPendingClaim, useStore } from '../store';
import type { Coin, ListingContact, ModalState, Place } from '../types';
import {
  Button,
  Checkbox,
  CodeInput,
  DemoNote,
  Icon,
  IconButton,
  Modal,
  ModalFooter,
  ModalHeader,
  ModalStep,
  OptionCard,
  OptionGroup,
  Sk,
  TextField,
  useLatest,
} from '../ui';
import { WalletPicker } from '../wallet/WalletPicker';
import { getPreClaim, setPreClaim } from './preclaims';
import { isOwnBusinessHost } from '../../worker/wire';
import './claim.css';

type ClaimModal = Extract<ModalState, { kind: 'claim' }>;
type Screen =
  | 'verify'
  | 'code'
  | 'payout'
  | 'done'
  | 'claimed'
  | 'other'
  | 'website'
  | 'email'
  | 'email-sent'
  | 'manual'
  | 'review-done';

const STEPS = ['Verify', 'Code', 'Payout', 'Done'] as const;
const STEP_OF: Record<Screen, number> = {
  verify: 0,
  other: 0,
  website: 0,
  email: 0,
  'email-sent': 0,
  manual: 0,
  claimed: 0,
  code: 1,
  payout: 2,
  done: 3,
  'review-done': 3,
};
const NOTE = 'Demo — no real call is made';
const CALLING_MS = 3000;
const MAX_TRIES = 3;
const CALLS_PER_HOUR = 5;
const PHOTO_MAX = 5 * 1024 * 1024;

/* ------------------------------------------------------------------ simulated server-side limits */

/** Per-place call log (prototype stand-in for the Worker's per-place/IP/wallet rate limits). */
const callLog = new Map<string, number[]>();
function recentCalls(placeId: string): number[] {
  const hourAgo = Date.now() - 3_600_000;
  const list = (callLog.get(placeId) ?? []).filter((t) => t > hourAgo);
  callLog.set(placeId, list);
  return list;
}
function rateLimited(placeId: string): boolean {
  return recentCalls(placeId).length >= CALLS_PER_HOUR;
}
function logCall(placeId: string): void {
  callLog.set(placeId, [...recentCalls(placeId), Date.now()]);
}

/** Deterministic verification codes per place: `atlaspad-verify=7KQ2-M9XD`, `CS-7KQ2`. */
function codesFor(placeId: string): { website: string; manual: string } {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let h = hashString(`verify:${placeId}`);
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += alphabet[h % alphabet.length];
    h = Math.floor(h / alphabet.length) ^ hashString(`${i}:${placeId}`);
    h >>>= 0;
  }
  return { website: `atlaspad-verify=${s.slice(0, 4)}-${s.slice(4)}`, manual: `CS-${s.slice(0, 4)}` };
}

/** The Place behind a claim (selected place, coin snapshot, demo place, or a Google stub). */
function resolvePlace(placeId: string): Place {
  const st = useStore.getState();
  if (st.selected.place?.id === placeId) return st.selected.place;
  const coin = st.coins[placeId];
  if (coin) return placeFromCoin(coin);
  const source = sourceFromId(placeId);
  if (source === 'demo') {
    const demo = getDemoPlace(placeId, st.coins);
    if (demo) return demo;
  }
  return googlePlaceStub(placeId, { lat: 0, lng: 0 });
}

type ContactState = { status: 'loading' } | { status: 'ready'; contact: ListingContact } | { status: 'error' } | { status: 'limited' };

function demoContact(place: Place): ListingContact {
  const d = place.demo;
  if (!d?.phone) return { masked: null, websiteHost: d?.website ?? null, blocked: 'no-phone' };
  return { masked: maskPhone(d.phone), websiteHost: d.website ?? null, blocked: null };
}

/* ================================================================== outer: one session per open */

/**
 * The simulated (demo-mode) claim flow. Real mode never loads this module: App's `loadClaim` imports
 * ./RealClaimFlow instead, so the two flows stay in separate chunks (no demo code is prefetched in real mode).
 */
export default function ClaimFlow() {
  return <DemoClaimFlow />;
}

function DemoClaimFlow() {
  const current = useStore((s) => (s.modal?.kind === 'claim' ? (s.modal as ClaimModal) : null));
  const last = useLatest(current);
  const open = current != null;
  const [session, setSession] = useState(0);
  // false (not `open`): when this module loads lazily with the modal already open, the first render still starts a session
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSession((s) => s + 1);
  }
  if (!last) return null;
  return <ClaimSession key={session} open={open} placeId={last.placeId} startAt={last.step} />;
}

/* ================================================================== session */

function ClaimSession({ open, placeId, startAt }: { open: boolean; placeId: string; startAt?: 'verify' | 'payout' }) {
  const closeModal = useStore((s) => s.closeModal);
  const openModal = useStore((s) => s.openModal);
  const wallet = useStore((s) => s.wallet.address);
  const online = useStore((s) => s.online);
  const provider = useStore((s) => s.provider);
  const solUsd = useStore((s) => s.solUsd);
  const coin = useStore((s) => s.coins[placeId]) as Coin | undefined;
  const place = useMemo(() => resolvePlace(placeId), [placeId]);
  const codes = useMemo(() => codesFor(placeId), [placeId]);
  const h = useId();
  const bodyRef = useRef<HTMLDivElement>(null);

  /* ---------------- initial screen */
  const [screen, setScreen] = useState<Screen>(() => {
    const st = useStore.getState();
    const c = st.coins[placeId];
    const me = st.wallet.address;
    const pre = getPreClaim(placeId);
    const ownsIt = (c && isOwner(c, me)) || (!c && !!pre && !!me && pre.owner === me);
    if (ownsIt && (startAt === 'payout' || !c || c.claimed)) return 'payout';
    if (c?.claimed) return 'claimed';
    return 'verify';
  });
  const settingsMode = useRef(screen === 'payout').current;

  /* ---------------- listing contact (server-side lookup; the client only sees a masked number) */
  const [contact, setContact] = useState<ContactState>({ status: 'loading' });
  const [lookup, setLookup] = useState(0);
  useEffect(() => {
    let on = true;
    if (place.source === 'demo') {
      setContact({ status: 'ready', contact: demoContact(place) });
      return;
    }
    if (place.source !== 'google') {
      setContact({ status: 'ready', contact: { masked: null, websiteHost: null, blocked: 'no-phone' } });
      return;
    }
    setContact({ status: 'loading' });
    getListedPhoneMasked(place.id)
      .then((c) => {
        if (!on) return;
        const err = c.error;
        if (err === 'unavailable') setContact({ status: 'error' });
        else if (err === 'rate-limited') setContact({ status: 'limited' });
        else setContact({ status: 'ready', contact: c });
      })
      .catch(() => on && setContact({ status: 'error' }));
    return () => {
      on = false;
    };
  }, [place, lookup]);
  const listing = contact.status === 'ready' ? contact.contact : null;
  const masked = listing?.masked ?? null;
  const rawHost = listing?.websiteHost ? listing.websiteHost.replace(/^www\./, '') : null;
  // only the business's own domain can verify (TripAdvisor, Facebook… are platforms, not the shop)
  const host = rawHost && (place.source === 'demo' || isOwnBusinessHost(rawHost)) ? rawHost : null;

  /* ---------------- timers */
  const timers = useRef<number[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      timers.current.forEach((t) => clearTimeout(t));
      timers.current = [];
    };
  }, []);
  const later = (fn: () => void, ms: number) => {
    const t = window.setTimeout(() => {
      timers.current = timers.current.filter((x) => x !== t);
      if (alive.current) fn();
    }, ms);
    timers.current.push(t);
  };

  /* ---------------- code step */
  const [calling, setCalling] = useState(false);
  const [code, setCode] = useState('');
  const [wrong, setWrong] = useState(0);
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  const locked = wrong >= MAX_TRIES;

  /* ---------------- payout */
  const existingPayout = coin?.payoutWallet ?? getPreClaim(placeId)?.payoutWallet ?? null;
  const [payMode, setPayMode] = useState<'connected' | 'other'>(() =>
    settingsMode && existingPayout && existingPayout !== useStore.getState().wallet.address ? 'other' : 'connected',
  );
  const [addr, setAddr] = useState(() => (settingsMode && existingPayout && existingPayout !== useStore.getState().wallet.address ? existingPayout : ''));
  const [addrTouched, setAddrTouched] = useState(false);
  const [agree, setAgree] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [payoutFrom, setPayoutFrom] = useState<Screen>('code');
  const [result, setResult] = useState<{ amountUsd: number; payout: string } | null>(null);

  /* ---------------- other ways */
  const [otherFrom, setOtherFrom] = useState<Screen>('verify');
  const [webChecking, setWebChecking] = useState(false);
  const [emailLocal, setEmailLocal] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [emailSending, setEmailSending] = useState(false);
  const [emailCooldown, setEmailCooldown] = useState(0);
  useEffect(() => {
    if (emailCooldown <= 0) return;
    const t = setTimeout(() => setEmailCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(t);
  }, [emailCooldown]);
  const [postLink, setPostLink] = useState('');
  const [linkTouched, setLinkTouched] = useState(false);
  const [photo, setPhoto] = useState<{ name: string; url: string } | null>(null);
  const [photoErr, setPhotoErr] = useState<string | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  // revoke the previous preview URL when it changes / on unmount
  useEffect(
    () => () => {
      if (photo) URL.revokeObjectURL(photo.url);
    },
    [photo],
  );

  /* ---------------- focus the new screen */
  const firstScreen = useRef(true);
  useEffect(() => {
    if (firstScreen.current) {
      firstScreen.current = false;
      return;
    }
    const root = bodyRef.current;
    const target = root?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)') ?? root?.querySelector<HTMLElement>('h2');
    target?.focus({ preventScroll: true });
    root?.closest('.dialog')?.scrollTo({ top: 0 });
  }, [screen]);

  // After the last wrong code the boxes stay disabled, so focus (dropped to <body> while the code
  // was checked) would sit outside the dialog: keep it on the step heading instead.
  useEffect(() => {
    if (!locked || screen !== 'code') return;
    const a = document.activeElement;
    if (!a || a === document.body || (a instanceof HTMLElement && a.matches(':disabled'))) {
      bodyRef.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
    }
  }, [locked, screen]);

  /* ---------------- derived */
  const waiting = coin ? feesWaiting(coin) : 0;
  const pending = !!coin?.claimPending && !coin.claimed;
  const limited = rateLimited(placeId) || contact.status === 'limited';
  const busy = calling;

  /* ---------------- actions */
  const close = () => {
    if (!busy) closeModal();
  };

  const placeCall = () => {
    if (rateLimited(placeId)) {
      setCodeErr('Too many attempts. Try again in 1 hour.');
      return false;
    }
    logCall(placeId);
    setCalling(true);
    setCode('');
    setWrong(0);
    setCodeErr(null);
    setCooldown(RESEND_COOLDOWN_S);
    later(() => setCalling(false), CALLING_MS);
    return true;
  };

  const startCall = () => {
    if (!masked || pending || limited || !online) return;
    if (placeCall()) setScreen('code');
  };

  const verifyCode = (digits = code) => {
    if (digits.length < 6 || checking || locked) return;
    setChecking(true);
    later(() => {
      setChecking(false);
      if (digits === DEMO_CLAIM_CODE) {
        setCodeErr(null);
        setPayoutFrom('code');
        setScreen('payout');
        return;
      }
      const n = wrong + 1;
      setWrong(n);
      setCode('');
      const left = MAX_TRIES - n;
      setCodeErr(left > 0 ? `That code didn't match. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Request a new call.');
    }, 800);
  };

  const toOther = (from: Screen) => {
    setOtherFrom(from);
    setScreen('other');
  };

  const payoutAddress = payMode === 'connected' ? wallet : addr.trim();
  const addrErr = payMode === 'other' && (addrTouched || addr.length > 30) && !isValidSolanaAddress(addr) ? "That isn't a valid Solana address" : null;
  const payoutValid = !!payoutAddress && isValidSolanaAddress(payoutAddress);

  const submitPayout = () => {
    if (!wallet || !payoutAddress || !payoutValid || submitting) {
      setAddrTouched(true);
      return;
    }
    const st = useStore.getState();
    if (settingsMode) {
      const c = st.coins[placeId];
      let ok = false;
      if (c) ok = st.setPayoutWallet(placeId, payoutAddress);
      else {
        const pre = getPreClaim(placeId);
        if (pre && pre.owner === wallet) {
          setPreClaim(placeId, { ...pre, payoutWallet: payoutAddress });
          ok = true;
        }
      }
      if (ok) {
        st.toast(`Payout wallet updated · ${shortAddr(payoutAddress)}`, 'ok');
        closeModal();
      } else st.toast("Only the verified owner can change the payout wallet.", 'error');
      return;
    }
    if (!agree) return;
    setSubmitting(true);
    later(() => {
      const s2 = useStore.getState();
      const c = s2.coins[placeId];
      if (c) {
        const r = s2.claimFees(placeId, payoutAddress);
        setSubmitting(false);
        if (!r.ok) {
          if (r.reason === 'already-claimed') setScreen('claimed');
          else s2.toast(r.message, 'error');
          return;
        }
        setResult({ amountUsd: r.amountUsd, payout: payoutAddress });
      } else {
        setPreClaim(placeId, { owner: wallet, payoutWallet: payoutAddress, verifiedAt: Date.now() });
        setSubmitting(false);
        setResult({ amountUsd: 0, payout: payoutAddress });
      }
      setScreen('done');
    }, 900);
  };

  const checkWebsite = () => {
    if (webChecking) return;
    setWebChecking(true);
    later(() => {
      setWebChecking(false);
      setPayoutFrom('website');
      setScreen('payout');
    }, 1500);
  };

  const emailOk = /^[a-z0-9._%+-]+$/i.test(emailLocal.trim());
  const sendEmail = () => {
    setEmailTouched(true);
    if (!emailOk || emailSending) return;
    setEmailSending(true);
    later(() => {
      setEmailSending(false);
      setEmailCooldown(RESEND_COOLDOWN_S);
      setScreen('email-sent');
    }, 800);
  };

  const linkOk = /^https?:\/\/[^\s.]+\.[^\s]{2,}/i.test(postLink.trim());
  const linkErr = linkTouched && postLink.trim() && !linkOk ? 'Paste the full link, starting with https://' : null;
  const onPhoto = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/') || f.size > PHOTO_MAX) {
      setPhotoErr('Use a photo under 5 MB.');
      return;
    }
    setPhotoErr(null);
    setPhoto({ name: f.name, url: URL.createObjectURL(f) });
  };
  const [reviewSending, setReviewSending] = useState(false);
  const submitReview = () => {
    if (!(linkOk || photo) || reviewSending) return;
    setReviewSending(true);
    later(() => {
      setReviewSending(false);
      if (useStore.getState().coins[placeId]) useStore.getState().setClaimPending(placeId, true);
      setScreen('review-done');
    }, 1200);
  };

  /* ---------------- shared bits */
  const placeCard =
    place.source === 'google' ? (
      provider === 'google' ? (
        <GooglePlaceCompact placeId={place.id} />
      ) : null
    ) : place.source === 'demo' ? (
      <DemoPlaceCompact place={place} />
    ) : null;

  const banner = (text: string, tone: 'amber' | 'neutral' = 'amber', icon = 'warning') => (
    <div className={['dlg-box', 'cl-banner', tone === 'neutral' ? 'neutral' : ''].filter(Boolean).join(' ')} role="status">
      <Icon name={icon} />
      <div>
        <b>{text}</b>
      </div>
    </div>
  );

  const backTo = (s: Screen, label = 'Back') => (
    <Button variant="text" icon="arrow_back" className="cl-back" onClick={() => setScreen(s)}>
      {label}
    </Button>
  );

  /* ---------------- screens */
  let body: ReactNode;
  switch (screen) {
    case 'verify': {
      let blockedText: string | null = null;
      let primary: ReactNode;
      const seeOther = (
        <Button variant="primary" onClick={() => toOther('verify')} data-autofocus>
          See other ways
        </Button>
      );
      // a manual-review claim sent from this browser is "yours", not "someone" (DESIGN §12.3 Manual review)
      const ownPending = pending && isOwnPendingClaim(placeId);
      if (ownPending) blockedText = "Your claim is being reviewed. We'll show \"Owner verification in progress\" on the shop until then — usually within 3 days.";
      else if (pending) blockedText = 'Someone is verifying this shop right now. Try again in 10 minutes.';
      else if (limited) blockedText = 'Too many attempts. Try again in 1 hour.';
      else if (contact.status === 'ready' && (listing?.blocked === 'no-phone' || !masked)) blockedText = 'This listing has no phone number. Choose another way to verify.';
      else if (contact.status === 'ready' && listing?.blocked === 'premium') blockedText = "We can't call this number. Choose another way to verify.";

      if (ownPending) {
        primary = (
          <Button variant="primary" onClick={close} data-autofocus>
            Done
          </Button>
        );
      } else if (pending || limited) {
        primary = (
          <Button variant="primary" icon="phone_in_talk" disabled>
            Call me with a code
          </Button>
        );
      } else if (blockedText) primary = seeOther;
      else if (contact.status === 'error') {
        primary = (
          <Button variant="primary" icon="refresh" onClick={() => setLookup((n) => n + 1)}>
            Try again
          </Button>
        );
      } else {
        primary = (
          <Button
            variant="primary"
            icon="phone_in_talk"
            disabled={contact.status !== 'ready' || !online}
            tip={!online ? "You're offline" : undefined}
            onClick={startCall}
            data-autofocus
          >
            Call me with a code
          </Button>
        );
      }
      body = (
        <>
          <h2 id={h} tabIndex={-1}>
            Claim fees for this shop
          </h2>
          <p className="dlg-sub">We'll call the phone number on this shop's Google listing and read out a 6-digit code.</p>
          {placeCard}
          {blockedText ? (
            banner(blockedText, 'amber', ownPending ? 'schedule' : 'warning')
          ) : contact.status === 'error' ? (
            banner("We couldn't look up this listing right now. Try again, or choose another way to verify.")
          ) : (
            <>
              <div className="cl-number" aria-busy={contact.status === 'loading' || undefined}>
                <Icon name="call" />
                <span className="cl-number-tx">
                  <small>Listed number</small>
                  {contact.status === 'loading' ? <Sk w={150} h={18} /> : <b className="num">{masked}</b>}
                </span>
              </div>
              <p className="cl-note">We look this number up on Google ourselves. It can't be changed here.</p>
            </>
          )}
          {waiting > 0 ? (
            <div className="dlg-box">
              <Icon name="payments" fill />
              <div>
                <b>{usdFull(waiting)} waiting for this shop</b>
                <small>{solApprox(waiting / solUsd)} · paid to the wallet you choose next</small>
              </div>
            </div>
          ) : null}
          <ModalFooter note={NOTE}>
            {/* no fallback while someone else verifies; redundant when the primary is already "See other ways" */}
            {pending || (blockedText && !limited) ? null : (
              <Button variant="text" onClick={() => toOther('verify')}>
                Can't answer this number?
              </Button>
            )}
            {primary}
          </ModalFooter>
        </>
      );
      break;
    }

    case 'code':
      body = (
        <>
          <h2 id={h} tabIndex={-1}>
            Enter the code
          </h2>
          <p className="dlg-sub">
            We're calling <span className="num">{masked}</span> now. Answer and listen for 6 digits.
          </p>
          <div className="cl-call" role="status" aria-live="polite">
            <span className={['cl-call-ic', calling ? 'ringing' : ''].filter(Boolean).join(' ')}>
              <Icon name="phone_in_talk" />
            </span>
            <span>{calling ? 'Calling…' : 'Call placed · code expires in 10 minutes'}</span>
          </div>
          <div className="dlg-box">
            <Icon name="info" />
            <div>
              <b>Demo code: 482 913</b>
              <small>No call is made in the demo.</small>
            </div>
          </div>
          <CodeInput
            value={code}
            onChange={(v) => {
              setCode(v);
              if (codeErr && !locked) setCodeErr(null);
            }}
            onComplete={(v) => verifyCode(v)}
            error={!!codeErr && wrong > 0}
            shakeKey={wrong}
            disabled={locked || checking}
            autoFocus
          />
          {codeErr ? (
            <p className="tf-help err cl-center" role="alert">
              {codeErr}
            </p>
          ) : null}
          <div className="cl-links">
            <Button
              variant="text"
              disabled={cooldown > 0 || calling}
              onClick={() => {
                placeCall();
              }}
            >
              {cooldown > 0 ? `Call again in ${countdown(cooldown)}` : 'Call me again'}
            </Button>
            <Button variant="text" onClick={() => toOther('code')}>
              Use another way
            </Button>
          </div>
          <ModalFooter note={NOTE}>
            <Button variant="text" onClick={() => setScreen('verify')} disabled={calling}>
              Back
            </Button>
            <Button variant="primary" disabled={code.length < 6 || locked} loading={checking} onClick={() => verifyCode()}>
              {checking ? 'Checking…' : 'Verify'}
            </Button>
          </ModalFooter>
        </>
      );
      break;

    case 'payout':
      if (!wallet) {
        body = (
          <>
            <WalletPicker
              title="Sign in to get paid"
              sub="Connect the Solana wallet that should receive this shop's fees. Nothing is signed in the demo."
              headingId={h}
              onConnected={() => {
                /* stays on Payout; the form appears */
              }}
            />
            <ModalFooter note={NOTE}>
              {settingsMode ? null : (
                <Button variant="text" onClick={() => setScreen(payoutFrom)}>
                  Back
                </Button>
              )}
            </ModalFooter>
          </>
        );
        break;
      }
      body = (
        <>
          <h2 id={h} tabIndex={-1}>
            Where should the fees go?
          </h2>
          <p className="dlg-sub" translate="no">
            {coin ? `Fees for $${coin.ticker} are paid to this Solana wallet.` : "Fees for this shop's coin are paid to this Solana wallet."}
          </p>
          <OptionGroup label="Payout wallet" className="opt-list">
            <OptionCard
              icon="account_balance_wallet"
              title="Connected wallet"
              sub={<span className="num">{shortAddr(wallet)}</span>}
              checked={payMode === 'connected'}
              onSelect={() => setPayMode('connected')}
            />
            <OptionCard icon="edit" title="Another address" checked={payMode === 'other'} onSelect={() => setPayMode('other')} />
          </OptionGroup>
          {payMode === 'other' ? (
            <TextField
              label="Solana address"
              mono
              value={addr}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              maxLength={44}
              onChange={(e) => setAddr(e.target.value.replace(/\s+/g, ''))}
              onBlur={() => setAddrTouched(true)}
              error={addrErr}
              translate="no"
              data-autofocus
            />
          ) : null}
          {settingsMode ? null : (
            <>
              <div className="dlg-box">
                <Icon name="schedule" />
                <div>
                  <b>72-hour hold on the first payout</b>
                  <small>So a hijacked listing can be disputed before any money moves.</small>
                </div>
              </div>
              <Checkbox checked={agree} onChange={(e) => setAgree(e.target.checked)}>
                I'm the owner of this business, or authorised by the owner.
              </Checkbox>
            </>
          )}
          <ModalFooter note={NOTE}>
            {settingsMode ? (
              <Button variant="text" onClick={close}>
                Cancel
              </Button>
            ) : (
              <Button variant="text" onClick={() => setScreen(payoutFrom)}>
                Back
              </Button>
            )}
            {settingsMode ? (
              <Button variant="primary" disabled={!payoutValid} onClick={submitPayout}>
                Save payout wallet
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={!agree || !payoutValid || !online}
                tip={!online ? "You're offline" : undefined}
                loading={submitting}
                onClick={submitPayout}
              >
                {waiting > 0 ? `Claim ${usdFull(waiting)}` : 'Claim this shop'}
              </Button>
            )}
          </ModalFooter>
        </>
      );
      break;

    case 'done': {
      const amount = result?.amountUsd ?? 0;
      const to = shortAddr(result?.payout ?? wallet ?? '');
      body = (
        <div className="dlg-center cl-done">
          <span className="big cl-big">
            <Icon name="verified" fill size={48} />
          </span>
          <h2 id={h} tabIndex={-1}>
            You've claimed this shop
          </h2>
          <p className="dlg-sub">
            {!coin
              ? `You're verified. When this shop gets a coin, its fees will be paid to ${to} after the 72-hour hold.`
              : amount > 0
                ? `${usdFull(amount)} (${solApprox(amount / solUsd)}) will be paid to ${to} after the 72-hour hold. New fees follow automatically.`
                : `Fees will be paid to ${to} after the 72-hour hold. New fees follow automatically.`}
          </p>
          <DemoNote />
          <div className="cl-done-btns">
            {coin ? (
              <Button variant="outline" icon="ios_share" onClick={() => openModal({ kind: 'share', placeId, variant: 'owner' })}>
                Share that you're verified
              </Button>
            ) : null}
            <Button variant="primary" onClick={closeModal} data-autofocus>
              Done
            </Button>
          </div>
        </div>
      );
      break;
    }

    case 'claimed':
      body = (
        <div className="dlg-center cl-done">
          <span className="big cl-big">
            <Icon name="verified" fill size={48} />
          </span>
          <h2 id={h} tabIndex={-1}>
            This shop is already claimed
          </h2>
          <p className="dlg-sub">If that's wrong, tell us and we'll review it.</p>
          <div className="cl-done-btns">
            <Button variant="outline" icon="flag" onClick={() => openModal({ kind: 'report', placeId, reason: 'other' })}>
              Report a problem
            </Button>
            <Button variant="primary" onClick={closeModal} data-autofocus>
              Close
            </Button>
          </div>
        </div>
      );
      break;

    case 'other':
      body = (
        <>
          {backTo(otherFrom === 'code' ? 'code' : 'verify', 'Back to phone call')}
          <h2 id={h} tabIndex={-1}>
            Other ways to verify
          </h2>
          <p className="dlg-sub">These take longer than a call.</p>
          <div className="cl-opts">
            <OptionCard
              kind="button"
              chevron
              icon="language"
              title="Code on your website"
              sub={host ? `Add a short code to a page on ${host}. We check it automatically.` : rawHost ? 'This listing has no website of its own' : 'This listing has no website'}
              disabled={!host}
              onSelect={() => setScreen('website')}
            />
            <OptionCard
              kind="button"
              chevron
              icon="mail"
              title="Email at your website's domain"
              sub={host ? `We'll send a link to an address @${host}.` : rawHost ? 'This listing has no website of its own' : 'This listing has no website'}
              disabled={!host}
              onSelect={() => setScreen('email')}
            />
            <OptionCard
              kind="button"
              chevron
              icon="support_agent"
              title="Manual review"
              sub="Post a code on the shop's socials, or send a photo of it in the shop. Takes 1–3 days."
              onSelect={() => setScreen('manual')}
            />
          </div>
          <ModalFooter note={NOTE} />
        </>
      );
      break;

    case 'website':
      body = (
        <>
          {backTo('other')}
          <h2 id={h} tabIndex={-1}>
            Code on your website
          </h2>
          <div className="cl-codebox">
            <span className="mono" translate="no">
              {codes.website}
            </span>
            <IconButton
              icon="content_copy"
              label="Copy code"
              onClick={() =>
                void copyText(codes.website).then((ok) =>
                  useStore.getState().toast(ok ? 'Code copied' : "Couldn't copy. Select and copy it manually.", ok ? 'ok' : 'error'),
                )
              }
            />
          </div>
          <p className="cl-p">Add this text anywhere on {host}, then press Check.</p>
          <ModalFooter note={NOTE}>
            <Button variant="text" onClick={() => setScreen('other')}>
              Back
            </Button>
            <Button variant="primary" loading={webChecking} onClick={checkWebsite} data-autofocus>
              {webChecking ? 'Checking…' : 'Check my website'}
            </Button>
          </ModalFooter>
        </>
      );
      break;

    case 'email':
      body = (
        <>
          {backTo('other')}
          <h2 id={h} tabIndex={-1}>
            Email at your website's domain
          </h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendEmail();
            }}
            noValidate
          >
            <TextField
              label="Email"
              value={emailLocal}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              suffix={`@${host ?? ''}`}
              onChange={(e) => setEmailLocal(e.target.value.replace(/[@\s]/g, ''))}
              onBlur={() => setEmailTouched(!!emailLocal)}
              error={emailTouched && !emailOk ? 'Enter the part before the @' : null}
              data-autofocus
            />
            <ModalFooter note={NOTE}>
              <Button variant="text" onClick={() => setScreen('other')}>
                Back
              </Button>
              <Button type="submit" variant="primary" loading={emailSending} disabled={!emailLocal.trim()}>
                Send link
              </Button>
            </ModalFooter>
          </form>
        </>
      );
      break;

    case 'email-sent':
      body = (
        <>
          {backTo('email')}
          <h2 id={h} tabIndex={-1}>
            Check your inbox
          </h2>
          <p className="dlg-sub">
            We sent a link to{' '}
            <b translate="no">
              {emailLocal}@{host}
            </b>
            . Open it on this device to continue.
          </p>
          <div className="cl-links cl-links-start">
            <Button
              variant="text"
              disabled={emailCooldown > 0}
              onClick={() => {
                setEmailCooldown(RESEND_COOLDOWN_S);
                useStore.getState().toast(`We sent a new link to ${emailLocal}@${host}`);
              }}
            >
              {emailCooldown > 0 ? `Resend in ${countdown(emailCooldown)}` : 'Resend'}
            </Button>
          </div>
          <Button
            variant="tonal"
            icon="mail"
            className="cl-demo-open"
            data-autofocus
            onClick={() => {
              setPayoutFrom('email-sent');
              setScreen('payout');
            }}
          >
            Demo: open the link
          </Button>
          <ModalFooter note={NOTE} />
        </>
      );
      break;

    case 'manual':
      body = (
        <>
          {backTo('other')}
          <h2 id={h} tabIndex={-1}>
            Manual review
          </h2>
          <p className="cl-bigcode mono" translate="no">
            {codes.manual}
          </p>
          <p className="cl-p cl-center">Post this code on the shop's Instagram, Facebook or X, or take a photo of it on paper inside the shop.</p>
          <TextField
            label="Link to the post"
            type="url"
            inputMode="url"
            value={postLink}
            autoComplete="off"
            onChange={(e) => setPostLink(e.target.value.trim())}
            onBlur={() => setLinkTouched(true)}
            error={linkErr}
            data-autofocus
          />
          <div className="cl-photo">
            <Button variant="outline" icon="photo_camera" onClick={() => photoRef.current?.click()}>
              {photo ? 'Change photo' : 'Add a photo'}
            </Button>
            <input ref={photoRef} type="file" accept="image/*" hidden onChange={onPhoto} />
            {photo ? (
              <span className="cl-photo-chip">
                <img src={photo.url} alt="" />
                <span className="cl-photo-name">{photo.name}</span>
                <IconButton icon="close" label="Remove photo" onClick={() => setPhoto(null)} />
              </span>
            ) : null}
          </div>
          {photoErr ? (
            <p className="tf-help err" role="alert">
              {photoErr}
            </p>
          ) : null}
          <ModalFooter note={NOTE}>
            <Button variant="text" onClick={() => setScreen('other')}>
              Back
            </Button>
            <Button variant="primary" disabled={!(linkOk || photo)} loading={reviewSending} onClick={submitReview}>
              Submit for review
            </Button>
          </ModalFooter>
        </>
      );
      break;

    case 'review-done':
    default:
      body = (
        <div className="dlg-center cl-done">
          <span className="big cl-big pending">
            <Icon name="schedule" size={48} />
          </span>
          <h2 id={h} tabIndex={-1}>
            We'll review your claim
          </h2>
          <p className="dlg-sub">Usually within 3 days. We'll show "Owner verification in progress" on the shop until then.</p>
          <DemoNote text={NOTE} />
          <div className="cl-done-btns">
            <Button variant="primary" onClick={closeModal} data-autofocus>
              Done
            </Button>
          </div>
        </div>
      );
      break;
  }

  const stepIdx = STEP_OF[screen];
  return (
    <Modal open={open} onClose={close} labelledBy={h} busy={busy} className="claim-dlg">
      <ModalHeader steps={{ labels: STEPS, current: stepIdx, done: settingsMode ? [0, 1] : undefined }} onClose={close} closeDisabled={busy} />
      <div ref={bodyRef}>
        <ModalStep stepKey={screen}>
          <div className={`cl-s cl-s-${screen}`}>{body}</div>
        </ModalStep>
      </div>
    </Modal>
  );
}
