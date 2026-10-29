/**
 * Claim modal in REAL mode (DESIGN §12.3 structure, INTEGRATION.md §3.5 + §7.5):
 *
 *   Verify  GET /api/claim/status (public window? someone verifying?) + the masked listing number
 *           (Phase-1 /api/claim/phone) → `Call me with a code` → POST /api/claim/call
 *   Code    devnet: no call is made, the code is shown on screen ("Devnet: your code is 123 456");
 *           mainnet: Twilio Verify calls the listing (cooldown from resendAfterSec) → POST /api/claim/check
 *   Payout  the CONNECTED wallet only (it signs request_claim) → `Request claim` → chain.requestClaim
 *           (co-sign → wallet → send → confirm → /api/claim/confirm) with tx states
 *   Done    `Claim requested` — withdraw after the public window (72 h mainnet, 1 min devnet)
 * Other ways: website code (own domain only, POST /api/claim/website), email (not available yet),
 * manual review (POST /api/report kind manual_claim; only while config.features.manualReview).
 * Owners reopen it at Payout: `Payout settings` = the owner wallet + Withdraw (collectAndWithdraw).
 *
 * Phone verification can be off (mainnet starts without Twilio: features.phoneVerification 'none'): Verify then
 * points the owner straight to the website code. A coin hidden from the map (moderation or opt-out) is still the
 * owner's: /api/claim/status returns it, so the whole claim and withdraw flow works without it being in the lists.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ClaimCallResponse, ClaimStatusResponse } from '../../worker/wire';
import { isOwnBusinessHost } from '../../worker/wire';
import { WELL_KNOWN_PATH, websiteMetaTag } from '../../worker/siteMarker';
import type { TxError, TxProgress, VaultView } from '../chain/types';
import { copyText } from '../lib/clipboard';
import { countdown, dateLong, shortAddr, usdOwed } from '../lib/format';
import { openExternal } from '../lib/nav';
import { devTestPhoneMasked, googlePlaceStub, isDevTestPlaceId, placeFromCoin } from '../lib/place';
import { CLUSTER } from '../mode';
import { GooglePlaceCompact } from '../panel/GoogleBlock';
import { getListedPhoneMasked } from '../places';
import { api, apiErrorMessage, isApiError, limitMessage } from '../realdata/api';
import { chain } from '../realdata/chain';
import { explorerTx } from '../realdata/explorer';
import { useChainConfig, useCountdown, useTx, useUsdFresh } from '../realdata/hooks';
import { refreshAfterTx } from '../realdata/index';
import { clearTx, isBusyPhase, phaseHelper, phaseLabel, runTx, withdrawLossWarning, withdrawToast } from '../realdata/tx';
import { lamportsToUsdFloor, solCeilSig, solFloorSig, u64 } from '../realdata/units';
import { useStore } from '../store';
import type { Coin, ListingContact, ModalState, Place } from '../types';
import {
  Button,
  Checkbox,
  CodeInput,
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
import { Turnstile } from './Turnstile';
import { CONTACT_EMAIL, PHONE_OFF_COPY, verifyGate } from './verifyGate';
import { formatWindow } from './window';
import './claim.css';

type ClaimModal = Extract<ModalState, { kind: 'claim' }>;
type Screen = 'verify' | 'code' | 'payout' | 'done' | 'claimed' | 'settings' | 'other' | 'website' | 'manual' | 'review-done';

const STEPS = ['Verify', 'Code', 'Payout', 'Done'] as const;
const STEP_OF: Record<Screen, number> = {
  verify: 0,
  other: 0,
  website: 0,
  manual: 0,
  claimed: 0,
  code: 1,
  payout: 2,
  settings: 2,
  done: 3,
  'review-done': 3,
};

/** `123 456` (spaced like DESIGN's `482 913`). */
function spaced(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

function resolvePlace(placeId: string): Place {
  const st = useStore.getState();
  if (st.selected.place?.id === placeId) return st.selected.place;
  const coin = st.coins[placeId];
  if (coin) return placeFromCoin(coin);
  return googlePlaceStub(placeId, { lat: 0, lng: 0 });
}

type ContactState = { status: 'loading' } | { status: 'ready'; contact: ListingContact } | { status: 'error' } | { status: 'limited' };
/** `none`: the place has no coin (the status route answers `no_coin`): a final answer, not an error to retry. */
type StatusState = { status: 'loading' } | { status: 'ready'; s: ClaimStatusResponse } | { status: 'none' } | { status: 'error'; msg: string };

export default function RealClaimFlow() {
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
  return <RealClaimSession key={session} open={open} placeId={last.placeId} startAt={last.step} />;
}

function RealClaimSession({ open, placeId, startAt }: { open: boolean; placeId: string; startAt?: 'verify' | 'payout' }) {
  const closeModal = useStore((s) => s.closeModal);
  const openModal = useStore((s) => s.openModal);
  const wallet = useStore((s) => s.wallet.address);
  const walletKind = useStore((s) => s.wallet.kind);
  const online = useStore((s) => s.online);
  const provider = useStore((s) => s.provider);
  const solUsd = useStore((s) => s.solUsd);
  const usdOk = useUsdFresh();
  const coin = useStore((s) => s.coins[placeId]) as Coin | undefined;
  const config = useChainConfig();
  const place = useMemo(() => resolvePlace(placeId), [placeId]);
  const h = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTx('claim');
    };
  }, []);

  const phoneMode = config?.features.phoneVerification ?? (CLUSTER === 'devnet' ? 'screen' : 'none');
  // manual review is closed on mainnet until its tooling exists (older Workers do not report it: devnet on, mainnet off)
  const manualReview = config?.features.manualReview ?? CLUSTER === 'devnet';
  const turnstileKey = config?.features.turnstileSiteKey ?? null;
  const windowSecs = config?.claimWindowSecs ?? (CLUSTER === 'devnet' ? 60 : 259_200);

  /* ---------------- initial screen */
  const [screen, setScreen] = useState<Screen>(() => {
    const st = useStore.getState();
    const c = st.coins[placeId];
    const me = st.wallet.address;
    if (c && me && c.claimed && c.owner === me) return 'settings';
    if (c?.claimed && startAt !== 'verify') return 'claimed';
    return 'verify';
  });

  /* ---------------- public claim status (on-chain owner / pending + someone verifying) */
  const [status, setStatus] = useState<StatusState>({ status: 'loading' });
  const [statusN, setStatusN] = useState(0);
  useEffect(() => {
    let on = true;
    setStatus({ status: 'loading' });
    api
      .claimStatus(placeId)
      .then((s) => on && setStatus({ status: 'ready', s }))
      .catch(
        (e: unknown) =>
          on && setStatus(isApiError(e) && e.code === 'no_coin' ? { status: 'none' } : { status: 'error', msg: apiErrorMessage(e, "We couldn't check this shop right now.") }),
      );
    return () => {
      on = false;
    };
  }, [placeId, statusN]);
  const st = status.status === 'ready' ? status.s : null;
  /** The place's coin from the claim status: also a coin hidden from the map, which is not in the app's lists. */
  const statusCoin = st?.coin ?? null;
  const hasCoin = !!coin || !!statusCoin;
  const ticker = coin?.ticker ?? statusCoin?.ticker ?? null;
  // a hidden coin's owner opens straight at Payout settings once the status says the wallet owns it (once only:
  // "Verify again" must stay possible)
  const ownerOpened = useRef(false);
  useEffect(() => {
    if (ownerOpened.current || !st || coin) return;
    ownerOpened.current = true;
    if (wallet && st.owner.owner === wallet && st.owner.status === 'claimed' && startAt !== 'verify') setScreen((s) => (s === 'verify' ? 'settings' : s));
  }, [st, coin, wallet, startAt]);

  /* ---------------- listing contact (masked number + website host; looked up server-side) */
  const [contact, setContact] = useState<ContactState>({ status: 'loading' });
  const [lookup, setLookup] = useState(0);
  useEffect(() => {
    let on = true;
    if (isDevTestPlaceId(placeId)) {
      // devnet synthetic place: the same fictitious number the Worker reports when it "calls" (never a real one)
      setContact({ status: 'loading' });
      void devTestPhoneMasked(placeId)
        .then((masked) => on && setContact({ status: 'ready', contact: { masked, websiteHost: null, blocked: null } }))
        .catch(() => on && setContact({ status: 'error' }));
      return () => {
        on = false;
      };
    }
    setContact({ status: 'loading' });
    getListedPhoneMasked(placeId)
      .then((c) => {
        if (!on) return;
        if (c.error === 'unavailable') setContact({ status: 'error' });
        else if (c.error === 'rate-limited') setContact({ status: 'limited' });
        else setContact({ status: 'ready', contact: c });
      })
      .catch(() => on && setContact({ status: 'error' }));
    return () => {
      on = false;
    };
  }, [placeId, lookup]);
  const listing = contact.status === 'ready' ? contact.contact : null;
  const host = listing?.websiteHost ? listing.websiteHost.replace(/^www\./, '') : null;
  const ownHost = isOwnBusinessHost(host);

  /* ---------------- call + code */
  const [call, setCall] = useState<ClaimCallResponse | null>(null);
  /** Devnet only: the code to show on screen (`channel: 'screen'`). */
  const [screenCodeValue, setScreenCode] = useState<string | null>(null);
  const [calling, setCalling] = useState(false);
  const [callErr, setCallErr] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileN, setTurnstileN] = useState(0);
  const [code, setCode] = useState('');
  const [wrong, setWrong] = useState(0);
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [locked, setLocked] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [ringing, setRinging] = useState(false);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  useEffect(() => {
    if (!ringing) return;
    const t = setTimeout(() => setRinging(false), 3000);
    return () => clearTimeout(t);
  }, [ringing]);

  /** Token from /api/claim/check or /api/claim/website (valid 30 min). */
  const [claim, setClaim] = useState<{ claimId: string; claimToken: string } | null>(null);

  /* ---------------- payout / request_claim */
  const tx = useTx('claim', placeId);
  const [agree, setAgree] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [progress, setProgress] = useState<TxProgress | null>(null);
  const [reqErr, setReqErr] = useState<TxError | null>(null);
  const [result, setResult] = useState<{ unlockTs: number; inProbation: boolean; claimWindowSecs: number; signature: string } | null>(null);

  /* ---------------- other ways */
  const [web, setWeb] = useState<{ claimId: string; code: string; host: string } | null>(null);
  const [webBusy, setWebBusy] = useState(false);
  const [webErr, setWebErr] = useState<string | null>(null);
  const [postLink, setPostLink] = useState('');
  const [linkTouched, setLinkTouched] = useState(false);
  const [reviewSending, setReviewSending] = useState(false);
  const [reviewErr, setReviewErr] = useState<string | null>(null);

  /* ---------------- owner settings: live vault + withdraw */
  const [vault, setVault] = useState<VaultView | null>(null);
  const [vaultN, setVaultN] = useState(0);
  const [withdrawing, setWithdrawing] = useState(false);
  const [wErr, setWErr] = useState<TxError | null>(null);
  const wTx = useTx('withdraw', placeId);
  useEffect(() => {
    if (screen !== 'settings' && screen !== 'verify') return;
    let on = true;
    chain()
      .then((a) => a.getVault(placeId))
      .then((v) => on && setVault(v.exists ? v : null))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [screen, placeId, vaultN]);

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

  /* ---------------- derived */
  const real = coin?.real;
  const waitingLamports = vault ? vault.fees.total : u64(real?.feesWaitingLamports ?? '0');
  const pendingOnChain = st?.owner.status === 'pending' || real?.ownerStatus === 'pending';
  const unlockTs = st?.owner.unlockTs ?? real?.unlockTs ?? null;
  const unlockIn = useCountdown(pendingOnChain ? unlockTs : null);
  const verificationActive = !!st?.verificationActive;
  const txBusy = isBusyPhase(tx?.progress) || isBusyPhase(wTx?.progress);
  const busy = calling || txBusy;
  const fees = (lamports: bigint) => (usdOk && solUsd > 0 ? usdOwed(lamportsToUsdFloor(lamports, solUsd), lamports > 0n) : `${solFloorSig(lamports)} SOL`);

  /* ---------------- actions */
  const close = () => {
    if (!busy) closeModal();
  };

  const startCall = async (again = false) => {
    if (calling || !online) return;
    if (turnstileKey && !turnstileToken) {
      setCallErr('Complete the check above first.');
      return;
    }
    setCalling(true);
    setCallErr(null);
    try {
      const r = await api.claimCall({ placeId, ...(again && call ? { claimId: call.claimId } : {}), ...(turnstileToken ? { turnstileToken } : {}) });
      if (!alive.current) return;
      setCall(r);
      // the on-screen code exists on devnet only: this read is compiled out of mainnet builds
      setScreenCode(import.meta.env.VITE_CLUSTER === 'devnet' ? (r.devCode ?? null) : null);
      setCode('');
      setWrong(0);
      setLocked(false);
      setCodeErr(null);
      setCooldown(Math.max(0, r.resendAfterSec || 45));
      setRinging(r.channel === 'call');
      setScreen('code');
    } catch (e) {
      if (!alive.current) return;
      setCallErr(callErrorMessage(e));
      if (isApiError(e) && (e.code === 'claim_active' || e.code === 'claim_pending' || e.code === 'already_owner')) setStatusN((n) => n + 1);
    } finally {
      if (alive.current) {
        setCalling(false);
        if (turnstileKey) {
          setTurnstileToken(null);
          setTurnstileN((n) => n + 1);
        }
      }
    }
  };

  const verifyCode = async (digits = code) => {
    if (!call || digits.length < 6 || checking || locked) return;
    setChecking(true);
    try {
      const r = await api.claimCheck({ claimId: call.claimId, code: digits });
      if (!alive.current) return;
      if (r.approved) {
        setCodeErr(null);
        setClaim({ claimId: call.claimId, claimToken: r.claimToken });
        setScreen('payout');
        return;
      }
      const left = Math.max(0, r.attemptsLeft);
      setWrong((n) => n + 1);
      setCode('');
      if (left <= 0) {
        setLocked(true);
        setCodeErr('Too many wrong codes. Request a new call.');
      } else setCodeErr(`That code didn't match. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
    } catch (e) {
      if (!alive.current) return;
      setCode('');
      if (isApiError(e) && (e.code === 'claim_expired' || e.status === 410)) {
        setLocked(true);
        setCodeErr('This code expired. Request a new call.');
      } else if (isApiError(e) && e.code === 'too_many_attempts') {
        setLocked(true);
        setCodeErr('Too many wrong codes. Request a new call.');
      } else setCodeErr(apiErrorMessage(e, "We couldn't check the code. Try again."));
    } finally {
      if (alive.current) setChecking(false);
    }
  };

  const requestClaim = async () => {
    if (!claim || requesting || !agree) return;
    setRequesting(true);
    setReqErr(null);
    const out = await runTx('claim', placeId, async (signer, onProgress) => (await chain()).requestClaim({ placeId, claimId: claim.claimId, claimToken: claim.claimToken }, signer, onProgress), {
      onProgress: (p) => alive.current && setProgress(p),
    });
    if (!alive.current) return;
    setRequesting(false);
    if (out.ok) {
      setResult({ ...out.value, signature: out.signature });
      setScreen('done');
      void refreshAfterTx('claim', coin?.mint);
      return;
    }
    if (out.error.code === 'rejected') {
      clearTx('claim');
      setReqErr({ ...out.error, retryable: true });
      return;
    }
    setReqErr(out.error);
  };

  const withdraw = async () => {
    if (withdrawing) return;
    setWithdrawing(true);
    setWErr(null);
    const out = await runTx('withdraw', placeId, async (signer, onProgress) => (await chain()).collectAndWithdraw(placeId, signer, onProgress));
    if (!alive.current) return;
    setWithdrawing(false);
    if (out.ok) {
      useStore.getState().toast(withdrawToast(out.value, wallet), 'ok', {
        label: 'View tx',
        run: () => openExternal(out.explorerUrl || explorerTx(out.signature)),
      });
      setVaultN((n) => n + 1);
      void refreshAfterTx('withdraw', coin?.mint);
    } else if (out.error.code === 'rejected') clearTx('withdraw');
    else {
      setWErr(out.error);
      // refused for cost: re-read the vault so the screen shows the fee and turns Withdraw off
      if (out.error.code === 'uneconomic') setVaultN((n) => n + 1);
    }
  };

  const issueWebsiteCode = async () => {
    setScreen('website');
    if (web || webBusy) return;
    setWebBusy(true);
    setWebErr(null);
    try {
      const r = await api.claimWebsite({ placeId });
      if (!alive.current) return;
      if (r.status === 'code') setWeb({ claimId: r.claimId, code: r.code, host: r.host });
      else setWebErr("We couldn't create a code. Try again.");
    } catch (e) {
      if (alive.current) setWebErr(isApiError(e) && e.code === 'not_own_domain' ? 'This listing has no website of its own.' : apiErrorMessage(e, "We couldn't create a code. Try again."));
    } finally {
      if (alive.current) setWebBusy(false);
    }
  };

  const checkWebsite = async () => {
    if (!web || webBusy) return;
    setWebBusy(true);
    setWebErr(null);
    try {
      const r = await api.claimWebsite({ placeId, claimId: web.claimId });
      if (!alive.current) return;
      if (r.status === 'approved') {
        setClaim({ claimId: r.claimId, claimToken: r.claimToken });
        setScreen('payout');
      } else setWebErr("We couldn't find the code yet. It can take a few minutes after you publish.");
    } catch (e) {
      if (alive.current) setWebErr(apiErrorMessage(e, "We couldn't check your website. Try again."));
    } finally {
      if (alive.current) setWebBusy(false);
    }
  };

  const mintForPlace = coin?.mint ?? statusCoin?.mint ?? null;
  const manualCode = useMemo(() => `CS-${(mintForPlace ?? placeId).replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase()}`, [mintForPlace, placeId]);
  const linkOk = /^https:\/\/[^\s.]+\.[^\s]{2,}/i.test(postLink.trim());
  const linkErr = linkTouched && postLink.trim() && !linkOk ? 'Paste the full link, starting with https://' : null;
  const submitReview = async () => {
    if (!linkOk || reviewSending) return;
    setReviewSending(true);
    setReviewErr(null);
    try {
      await api.report({
        kind: 'manual_claim',
        placeId,
        ...(mintForPlace ? { mint: mintForPlace } : {}),
        reason: 'manual_claim',
        details: `Code ${manualCode} posted at ${postLink.trim()}${wallet ? ` · wallet ${wallet}` : ''}`.slice(0, 1000),
        ...(wallet ? { wallet } : {}),
      });
      if (alive.current) setScreen('review-done');
    } catch (e) {
      if (alive.current) setReviewErr(apiErrorMessage(e, "We couldn't send that. Try again."));
    } finally {
      if (alive.current) setReviewSending(false);
    }
  };

  /* ---------------- shared bits */
  const placeCard = place.source === 'google' && provider === 'google' && !isDevTestPlaceId(placeId) ? <GooglePlaceCompact placeId={place.id} /> : null;
  const banner = (text: ReactNode, tone: 'amber' | 'neutral' = 'amber', icon = 'warning') => (
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
  const txErrLine = (err: TxError | null, retry?: () => void) =>
    err ? (
      <p className="tf-help err cl-center" role="alert">
        {err.message}{' '}
        {err.retryable && retry ? (
          <button type="button" className="link-btn" onClick={retry}>
            Try again
          </button>
        ) : null}{' '}
        {err.signature ? (
          <button type="button" className="link-btn" onClick={() => openExternal(err.explorerUrl ?? explorerTx(err.signature ?? ''))}>
            View tx
          </button>
        ) : null}
      </p>
    ) : null;

  /* ---------------- screens */
  let body: ReactNode;
  switch (screen) {
    case 'verify': {
      const masked = listing?.masked ?? null;
      const noPhoneVerify = phoneMode === 'none';
      // phone check off: the website code (the listing's own domain only) is the way in
      const websiteWay = !!config?.features.websiteVerification && ownHost;
      const gate = verifyGate({
        phoneMode,
        statusReady: status.status === 'ready' || status.status === 'none',
        hasCoin,
        coinInList: !!coin,
        pending: pendingOnChain,
        pendingText: pendingOnChain && unlockTs ? `A claim for this shop is in its public window until ${dateLong(unlockTs * 1000)}${unlockIn > 0 ? ` (${countdown(unlockIn)} left)` : ''}.` : null,
        verificationActive,
        contact: contact.status,
        listingBlocked: listing?.blocked === 'no-phone' || listing?.blocked === 'premium' ? listing.blocked : null,
        masked,
        websiteWay,
        manualReview,
        anyError: contact.status === 'error' || status.status === 'error',
      });
      let primary: ReactNode;
      if (gate.action === 'blocked') {
        primary = (
          <Button variant="primary" icon={noPhoneVerify ? 'language' : 'phone_in_talk'} disabled>
            {noPhoneVerify ? 'Use a code on my website' : 'Call me with a code'}
          </Button>
        );
      } else if (gate.action === 'email') {
        primary = (
          <Button variant="primary" icon="mail" onClick={() => window.location.assign(`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Verify my shop on AtlasPad')}`)} data-autofocus>
            Email us
          </Button>
        );
      } else if (gate.action === 'website') {
        primary = (
          <Button
            variant="primary"
            icon="language"
            loading={gate.waiting}
            disabled={!websiteWay || !hasCoin || !online}
            tip={!online ? "You're offline" : undefined}
            onClick={() => void issueWebsiteCode()}
            data-autofocus
          >
            Use a code on my website
          </Button>
        );
      } else if (gate.action === 'other') {
        primary = (
          <Button variant="primary" onClick={() => setScreen('other')} data-autofocus>
            See other ways
          </Button>
        );
      } else if (gate.action === 'retry') {
        primary = (
          <Button
            variant="primary"
            icon="refresh"
            onClick={() => {
              setLookup((n) => n + 1);
              setStatusN((n) => n + 1);
            }}
          >
            Try again
          </Button>
        );
      } else {
        primary = (
          <Button
            variant="primary"
            icon="phone_in_talk"
            loading={calling}
            disabled={contact.status !== 'ready' || status.status !== 'ready' || !online || (!!turnstileKey && !turnstileToken)}
            tip={!online ? "You're offline" : undefined}
            onClick={() => void startCall()}
            data-autofocus
          >
            {phoneMode === 'screen' ? 'Get a code' : 'Call me with a code'}
          </Button>
        );
      }
      body = (
        <>
          <h2 id={h} tabIndex={-1}>
            Claim fees for this shop
          </h2>
          <p className="dlg-sub">
            {phoneMode === 'screen'
              ? "We'd call the phone number on this shop's Google listing with a 6-digit code. On devnet no call is made: the code shows here."
              : noPhoneVerify
                ? "Show us you run this business: add a short code to its website and we'll check it automatically."
                : "We'll call the phone number on this shop's Google listing and read out a 6-digit code."}
          </p>
          {placeCard}
          {gate.text ? (
            banner(gate.text, gate.tone, gate.icon)
          ) : contact.status === 'error' || status.status === 'error' ? (
            banner(status.status === 'error' ? status.msg : "We couldn't look up this listing right now. Try again, or choose another way to verify.")
          ) : noPhoneVerify ? (
            <Sk w="100%" h={56} />
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
              {turnstileKey ? <Turnstile siteKey={turnstileKey} onToken={setTurnstileToken} resetKey={turnstileN} /> : null}
            </>
          )}
          {callErr ? (
            <p className="tf-help err" role="alert">
              {callErr}
            </p>
          ) : null}
          {waitingLamports > 0n ? (
            <div className="dlg-box">
              <Icon name="payments" fill />
              <div>
                <b>{fees(waitingLamports)} waiting for this shop</b>
                <small>
                  {solFloorSig(waitingLamports)} SOL · {wallet ? <>paid to <span className="mono">{shortAddr(wallet)}</span> after verification</> : 'paid to the wallet you connect next'}
                </small>
              </div>
            </div>
          ) : null}
          <ModalFooter>
            {gate.link ? (
              <Button variant="text" onClick={() => setScreen('other')}>
                {gate.link === 'cant-answer' ? "Can't answer this number?" : 'Other ways'}
              </Button>
            ) : null}
            {primary}
          </ModalFooter>
        </>
      );
      break;
    }

    case 'code': {
      const screenCode = call?.channel === 'screen';
      body = (
        <>
          <h2 id={h} tabIndex={-1}>
            Enter the code
          </h2>
          <p className="dlg-sub">
            {screenCode ? (
              <>
                On devnet we don't call <span className="num">{call?.masked}</span>. Type the code shown below.
              </>
            ) : (
              <>
                We're calling <span className="num">{call?.masked}</span> now. Answer and listen for 6 digits.
              </>
            )}
          </p>
          <div className="cl-call" role="status" aria-live="polite">
            <span className={['cl-call-ic', ringing ? 'ringing' : ''].filter(Boolean).join(' ')}>
              <Icon name={screenCode ? 'phone_disabled' : 'phone_in_talk'} />
            </span>
            <span>{screenCode ? 'Devnet: no call is made' : ringing ? 'Calling…' : 'Call placed · code expires in 10 minutes'}</span>
          </div>
          {screenCode && screenCodeValue ? (
            <div className="dlg-box">
              <Icon name="info" />
              <div>
                <b>Devnet: your code is {spaced(screenCodeValue)}</b>
                <small>Mainnet calls the shop's listed number instead.</small>
              </div>
            </div>
          ) : null}
          <CodeInput
            value={code}
            onChange={(v) => {
              setCode(v);
              if (codeErr && !locked) setCodeErr(null);
            }}
            onComplete={(v) => void verifyCode(v)}
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
          {callErr ? (
            <p className="tf-help err cl-center" role="alert">
              {callErr}
            </p>
          ) : null}
          <div className="cl-links">
            <Button variant="text" disabled={cooldown > 0 || calling || (call?.callsLeft ?? 1) <= 0} loading={calling} onClick={() => void startCall(true)}>
              {cooldown > 0 ? `${screenCode ? 'New code' : 'Call again'} in ${countdown(cooldown)}` : screenCode ? 'Get a new code' : 'Call me again'}
            </Button>
            <Button variant="text" onClick={() => setScreen('other')}>
              Use another way
            </Button>
          </div>
          <ModalFooter>
            <Button variant="text" onClick={() => setScreen('verify')} disabled={calling}>
              Back
            </Button>
            <Button variant="primary" disabled={code.length < 6 || locked} loading={checking} onClick={() => void verifyCode()}>
              {checking ? 'Checking…' : 'Verify'}
            </Button>
          </ModalFooter>
        </>
      );
      break;
    }

    case 'payout': {
      if (!wallet || walletKind !== 'standard') {
        body = (
          <>
            <WalletPicker
              title="Sign in to get paid"
              sub="Connect the Solana wallet that should own this shop's fees. It signs the claim, and only it can withdraw."
              headingId={h}
              notice={wallet && walletKind !== 'standard' ? 'Email wallets can’t sign here yet. Connect Phantom, Solflare or Backpack.' : null}
              onConnected={() => {
                /* stays on Payout; the form appears */
              }}
            />
            <ModalFooter>
              <Button variant="text" onClick={() => setScreen('verify')}>
                Back
              </Button>
            </ModalFooter>
          </>
        );
        break;
      }
      const label = requesting ? phaseLabel(progress ?? tx?.progress, 'claim') : 'Request claim';
      const helper = requesting ? phaseHelper(progress ?? tx?.progress) : null;
      body = (
        <>
          <h2 id={h} tabIndex={-1}>
            Where should the fees go?
          </h2>
          <p className="dlg-sub" translate="no">
            {ticker ? `Fees for $${ticker} are paid to this Solana wallet.` : "Fees for this shop's coin are paid to this Solana wallet."}
          </p>
          <OptionGroup label="Payout wallet" className="opt-list">
            <OptionCard icon="account_balance_wallet" title="Connected wallet" sub={<span className="num">{shortAddr(wallet)}</span>} checked onSelect={() => {}} />
          </OptionGroup>
          <p className="cl-note">To get paid to another wallet, connect that wallet first.</p>
          <div className="dlg-box">
            <Icon name="schedule" />
            <div>
              <b>{formatWindow(windowSecs)} public window before you can withdraw</b>
              <small>So a hijacked listing can be disputed before any money moves.</small>
            </div>
          </div>
          <Checkbox checked={agree} onChange={(e) => setAgree(e.target.checked)}>
            I'm the owner of this business, or authorised by the owner.
          </Checkbox>
          {helper ? <p className="tx-help">{helper}</p> : null}
          {txErrLine(reqErr, () => void requestClaim())}
          <ModalFooter>
            <Button variant="text" onClick={() => setScreen('verify')} disabled={requesting}>
              Back
            </Button>
            <Button variant="primary" disabled={!agree || !online || !claim} tip={!online ? "You're offline" : undefined} loading={requesting} onClick={() => void requestClaim()}>
              {label}
            </Button>
          </ModalFooter>
        </>
      );
      break;
    }

    case 'done': {
      const win = formatWindow(result?.claimWindowSecs ?? windowSecs);
      const to = shortAddr(wallet ?? '');
      body = (
        <div className="dlg-center cl-done">
          <span className="big cl-big pending">
            <Icon name="schedule" size={48} />
          </span>
          <h2 id={h} tabIndex={-1}>
            Claim requested
          </h2>
          <p className="dlg-sub">
            After the {win} public window you can withdraw {waitingLamports > 0n ? fees(waitingLamports) : 'the fees'} to {to}. Anyone can dispute a wrong claim until then.
          </p>
          {result?.inProbation ? <p className="cl-note">Because our signing key changed recently, this claim unlocks on {dateLong(result.unlockTs * 1000)}.</p> : null}
          <div className="cl-done-btns">
            {result?.signature ? (
              <Button variant="outline" icon="open_in_new" onClick={() => openExternal(explorerTx(result.signature))}>
                View tx
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

    case 'settings': {
      // a hidden coin is not in the lists: its owner comes from the claim status
      const owner = coin?.owner ?? st?.owner.owner ?? null;
      const ready = vault ? vault.fees.total : u64(real?.feesWaitingLamports ?? '0');
      const isOwnerNow = !!owner && owner === wallet;
      const wLabel = withdrawing ? phaseLabel(wTx?.progress, 'withdraw') : `Withdraw ${fees(ready)}`;
      const cost = vault?.withdrawCostLamports;
      // the fee would eat the payout: Withdraw is off, with the reason (the chain layer refuses it too)
      const loss = withdrawLossWarning(ready, cost);
      const lossId = `${h}-loss`;
      body = (
        <>
          <h2 id={h} tabIndex={-1}>
            Payout settings
          </h2>
          <p className="dlg-sub" translate="no">
            {ticker ? `Fees for $${ticker} belong to the owner wallet. Only it can withdraw.` : 'Only the owner wallet can withdraw.'}
          </p>
          <div className="cl-number">
            <Icon name="account_balance_wallet" />
            <span className="cl-number-tx">
              <small>Owner wallet</small>
              <b className="num" translate="no">
                {shortAddr(owner)}
              </b>
            </span>
          </div>
          <div className="dlg-box">
            <Icon name="payments" fill />
            <div>
              <b>{fees(ready)} ready to withdraw</b>
              <small>
                {solFloorSig(ready)} SOL · exact, rounded down
                {ready > 0n && cost !== undefined && !loss ? ` · network fee ≈ ${solCeilSig(cost)} SOL` : ''}
              </small>
            </div>
          </div>
          {loss ? (
            <p className="cl-note" id={lossId}>
              {loss}
            </p>
          ) : null}
          <p className="cl-note">To change the owner wallet, connect the new wallet and verify again. The usual public window applies.</p>
          {withdrawing ? <p className="tx-help">{phaseHelper(wTx?.progress)}</p> : null}
          {txErrLine(loss && wErr?.code === 'uneconomic' ? null : wErr, () => void withdraw())}
          <ModalFooter>
            <Button variant="text" disabled={withdrawing} onClick={() => setScreen('verify')}>
              Verify again
            </Button>
            <Button
              variant="primary"
              icon="account_balance_wallet"
              disabled={!isOwnerNow || ready <= 0n || !online || !!loss}
              aria-describedby={loss ? lossId : undefined}
              loading={withdrawing}
              onClick={() => void withdraw()}
            >
              {wLabel}
            </Button>
          </ModalFooter>
        </>
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
          <p className="dlg-sub">If that's wrong, tell us and we'll review it. The real owner can also verify again: the public window applies.</p>
          <div className="cl-done-btns">
            <Button variant="outline" icon="flag" onClick={() => openModal({ kind: 'report', placeId, reason: 'other' })}>
              Report a problem
            </Button>
            <Button variant="outline" icon="phone_in_talk" onClick={() => setScreen('verify')}>
              Verify again
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
          {backTo('verify', phoneMode === 'none' ? 'Back' : 'Back to phone call')}
          <h2 id={h} tabIndex={-1}>
            Other ways to verify
          </h2>
          <p className="dlg-sub">{phoneMode === 'none' ? "Phone check isn't switched on yet." : 'These take longer than a call.'}</p>
          <div className="cl-opts">
            <OptionCard
              kind="button"
              chevron
              icon="language"
              title="Code on your website"
              sub={
                config?.features.websiteVerification && ownHost
                  ? `Add a short code to a page on ${host}. We check it automatically.`
                  : host && !ownHost
                    ? 'This listing has no website of its own'
                    : config?.features.websiteVerification === false
                      ? 'Not available yet'
                      : 'This listing has no website of its own'
              }
              disabled={!hasCoin || !config?.features.websiteVerification || !ownHost}
              onSelect={() => void issueWebsiteCode()}
            />
            <OptionCard kind="button" chevron icon="mail" title="Email at your website's domain" sub="Not available yet" disabled onSelect={() => {}} />
            {/* manual review is hidden until its tooling exists (features.manualReview; off on mainnet) */}
            {manualReview ? (
              <OptionCard
                kind="button"
                chevron
                icon="support_agent"
                title="Manual review"
                sub="Post a code on the shop's socials and send us the link. Takes 1–3 days."
                onSelect={() => setScreen('manual')}
              />
            ) : null}
          </div>
          <ModalFooter />
        </>
      );
      break;

    case 'website': {
      // with the phone check off, the website code is the first way in: Back returns to Verify
      const webBack: Screen = phoneMode === 'none' ? 'verify' : 'other';
      body = (
        <>
          {backTo(webBack)}
          <h2 id={h} tabIndex={-1}>
            Code on your website
          </h2>
          {web ? (
            <>
              {/* Only places the site owner controls count (never text in reviews or comments): a meta tag in the
                  home page's <head>, or a plain-text file. */}
              <p className="cl-p">Add this tag inside the &lt;head&gt; of {web.host}&apos;s home page:</p>
              <div className="cl-codebox">
                <span className="mono" translate="no">
                  {metaTag(web.code)}
                </span>
                <IconButton
                  icon="content_copy"
                  label="Copy tag"
                  onClick={() =>
                    void copyText(metaTag(web.code)).then((ok) => useStore.getState().toast(ok ? 'Tag copied' : "Couldn't copy. Select and copy it manually.", ok ? 'ok' : 'error'))
                  }
                />
              </div>
              <p className="cl-p">
                Or publish a plain-text file at {`${web.host}${WELL_KNOWN_PATH}`} containing <span className="mono">{web.code}</span>. Then press Check.
              </p>
            </>
          ) : webBusy ? (
            <Sk w="100%" h={56} />
          ) : null}
          {webErr ? (
            <p className="tf-help err" role="alert">
              {webErr}
            </p>
          ) : null}
          <ModalFooter>
            <Button variant="text" onClick={() => setScreen(webBack)}>
              Back
            </Button>
            <Button variant="primary" loading={webBusy && !!web} disabled={!web} onClick={() => void checkWebsite()} data-autofocus>
              {webBusy && web ? 'Checking…' : 'Check my website'}
            </Button>
          </ModalFooter>
        </>
      );
      break;
    }

    case 'manual':
      body = (
        <>
          {backTo('other')}
          <h2 id={h} tabIndex={-1}>
            Manual review
          </h2>
          <p className="cl-bigcode mono" translate="no">
            {manualCode}
          </p>
          <p className="cl-p cl-center">Post this code on the shop's Instagram, Facebook or X, then paste the link to the post.</p>
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
          {reviewErr ? (
            <p className="tf-help err" role="alert">
              {reviewErr}
            </p>
          ) : null}
          <ModalFooter>
            <Button variant="text" onClick={() => setScreen('other')}>
              Back
            </Button>
            <Button variant="primary" disabled={!linkOk} loading={reviewSending} onClick={() => void submitReview()}>
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
          <p className="dlg-sub">Usually within 3 days. If it checks out, we'll verify you and you claim from your wallet.</p>
          <div className="cl-done-btns">
            <Button variant="primary" onClick={closeModal} data-autofocus>
              Done
            </Button>
          </div>
        </div>
      );
      break;
  }

  const settings = screen === 'settings';
  return (
    <Modal open={open} onClose={close} labelledBy={h} busy={busy} className="claim-dlg">
      <ModalHeader steps={{ labels: STEPS, current: STEP_OF[screen], done: settings ? [0, 1] : undefined }} onClose={close} closeDisabled={busy} />
      <div ref={bodyRef}>
        <ModalStep stepKey={screen}>
          <div className={`cl-s cl-s-${screen}`}>{body}</div>
        </ModalStep>
      </div>
    </Modal>
  );
}

/** `atlaspad-verify=7KQ2-M9XD` → the meta tag the Worker looks for in the home page's <head> (worker/siteMarker.ts). */
const metaTag = websiteMetaTag;

/** API error → claim copy (DESIGN §12.3 blocking cases + INTEGRATION.md §3.0 codes). */
function callErrorMessage(e: unknown): string {
  if (!isApiError(e)) return "We couldn't start the call. Try again.";
  switch (e.code) {
    case 'claim_active':
      return 'Someone is verifying this shop right now. Try again in 10 minutes.';
    case 'claim_pending':
      return 'A claim for this shop is already in its public window.';
    case 'already_owner':
      return 'This wallet already owns this shop.';
    case 'no_phone':
      return 'This listing has no phone number. Choose another way to verify.';
    case 'premium':
      return "We can't call this number. Choose another way to verify.";
    case 'no_coin':
      return 'This shop has no coin yet.';
    case 'too_many_attempts':
    case 'rate_limited':
      // the server's reason with the real wait ("Too many calls to this number today. Try again in 11 hours.")
      return limitMessage(e);
    case 'not_configured':
    case 'not_enabled':
      return PHONE_OFF_COPY;
    default:
      return apiErrorMessage(e, "We couldn't start the call. Try again.");
  }
}
