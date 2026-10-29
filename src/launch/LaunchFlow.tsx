/**
 * Launch modal (DESIGN §12.2): Details → Sign in → Review → Launching → Success, plus the
 * "Someone launched this shop first", "This place can't have a coin" and "Launch failed" screens.
 * Renders when store.modal?.kind === 'launch'. Contract: default export, no props.
 *
 * Demo mode: simulated — store.launchCoin(draft) creates the coin (fake …pump mint), the optional
 * first buy registers as the user's holding. Nothing is signed or sent.
 * Real mode (INTEGRATION.md §7.4): Continue asks the Worker whether Google lists an open business
 * here; Review shows the real network fee + rent (estimateLaunchCost) and checks the balance; Launch
 * runs src/chain launchCoin (metadata upload → prepare → build → co-sign → wallet → send → confirm
 * → registry) with the three DESIGN rows following the tx phases.
 * What we save is the launcher's typed name/ticker (the Google displayName is only a prefill + the h2).
 */
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { usePhoneOff } from '../claim/phoneOff';
import { clearPreClaim, getPreClaim } from '../claim/preclaims';
import type { CoinRef, LaunchIneligibleReason } from '../../worker/wire';
import type { LaunchCostEstimate, LaunchInput, TradeFill, TxError, TxProgress, WalletSigner } from '../chain/types';
import { FIRST_BUY_OPTIONS_SOL, LIMITS, NETWORK_FEE_SOL, links } from '../config';
import { CATEGORY_OPTIONS, COIN_SWATCHES, categoryDef, categoryFromGoogle, categoryLabel, isCategoryKey } from '../lib/categories';
import { copyWithToast } from '../lib/clipboard';
import { solAmount, solNumber, tokenAmount } from '../lib/format';
import { fileToSquareDataUrl, stickerFor } from '../lib/logo';
import { openExternal } from '../lib/nav';
import { ineligibilityFromFacts, isDevTestPlaceId, knownIneligibility, placeFromCoin } from '../lib/place';
import { CLUSTER, IS_REAL } from '../mode';
import { apiErrorMessage } from '../realdata/api';
import { chain, prefetchChain, prefetchPump } from '../realdata/chain';
import { explorerTx } from '../realdata/explorer';
import { checkEligibility, ensurePlace, findCoinByMint, ingestCoins, loadWallet, refreshAfterTx } from '../realdata/index';
import { clearTx, getTestSol, insufficientMessage, isBusyPhase, phaseHelper, phaseLabel, runTx, shortfall, userCancelled } from '../realdata/tx';
import { parseSol, solCeil, unitsToTokens } from '../realdata/units';
import { encodeUpload, renderSticker } from './art';
import { TICKER_ERROR_MESSAGE, isTickerTaken, sanitizeTicker, tickerFromName, validateTicker } from '../lib/ticker';
import { DemoPlaceCompact } from '../panel/PlaceBlocks';
import { GooglePlaceCompact } from '../panel/GoogleBlock';
import { getLaunchPrefill } from '../places';
import { postOnX, sharePostText } from '../share/ShareModal';
import { useStore } from '../store';
import type { CategoryKey, Coin, LaunchDraft, LogoSpec, Place, TradeResult } from '../types';
import {
  Button,
  Checkbox,
  Icon,
  Modal,
  ModalFooter,
  ModalHeader,
  ModalStep,
  ModeNote,
  Seg,
  SelectField,
  Spinner,
  Sticker,
  TextField,
  XGlyph,
  useLatest,
} from '../ui';
import { WalletPicker } from '../wallet/WalletPicker';
import { clearDraft, getDraft, saveDraft, type LaunchDraftState } from './drafts';
import './launch.css';

type Step = 'details' | 'signin' | 'review' | 'launching' | 'success' | 'taken' | 'failed' | 'ineligible';
/** The coin that won the place (from the API / TxError.existing) when it isn't in the store yet. */
type TakenRef = Pick<CoinRef, 'placeId' | 'mint' | 'ticker'>;

const STEP_LABELS = ['Details', 'Sign in', 'Review', 'Launch'] as const;
const STEP_INDEX: Record<Step, number> = { details: 0, signin: 1, review: 2, launching: 3, success: 3, taken: 3, failed: 3, ineligible: 0 };
const RUN_ROWS = ['Creating the coin on pump.fun', "Pointing creator fees to the shop's vault", 'Putting it on the map'] as const;
const STEP_MS = 1000;
const ART_TYPES = /^image\/(png|jpe?g|webp|gif)$/i;
const ART_ERROR = 'Use a PNG, JPG, WebP or GIF under 2 MB.';
const WALLET_GONE = 'Your wallet disconnected. Sign in again to continue.';

const BUY_OPTIONS = FIRST_BUY_OPTIONS_SOL.map((v) => ({
  value: String(v),
  label: v === 0 ? 'None' : v === 0.1 ? '0.1 SOL' : solNumber(v),
  ariaLabel: v === 0 ? 'No first buy' : `${solNumber(v)} SOL`,
}));

function initialDraft(place: Place): LaunchDraftState {
  const saved = getDraft(place.id);
  if (saved) return saved;
  const category: CategoryKey =
    place.source === 'google' && (place.primaryType || place.types?.length) ? categoryFromGoogle(place.primaryType, place.types) : place.category;
  const look = stickerFor(place.id, category);
  const name = (place.name ?? '').slice(0, LIMITS.nameMax);
  return {
    name,
    ticker: tickerFromName(name),
    tickerEdited: false,
    nameEdited: false,
    description: '',
    category,
    emoji: categoryDef(category).stickers[0] ?? categoryDef(category).emoji,
    bg: look.bg,
    upload: null,
    devBuy: '0.1',
  };
}

/* ================================================================== outer: one session per open */

export default function LaunchFlow() {
  const current = useStore((s) => (s.modal?.kind === 'launch' ? s.modal : null));
  const last = useLatest(current);
  const open = current != null;
  const [session, setSession] = useState(0);
  // false (not `open`): when this module loads lazily with the modal already open, the first render still starts a session
  const [wasOpen, setWasOpen] = useState(false);
  const [blocked, setBlocked] = useState<Coin | null>(null);

  // new session on every open; a place that already has a coin never shows the form
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && current) {
      setSession((s) => s + 1);
      setBlocked(useStore.getState().coins[current.place.id] ?? null);
    }
  }

  useEffect(() => {
    if (!blocked) return;
    const st = useStore.getState();
    st.closeModal();
    if (st.selected.place?.id !== blocked.placeId || st.panel !== 'place') st.openPlace(placeFromCoin(blocked), { fly: true });
    st.toast(`This shop already has a coin — $${blocked.ticker}`);
    setBlocked(null);
  }, [blocked]);

  if (!last) return null;
  return <LaunchSession key={session} open={open && !blocked} place={last.place} />;
}

/* ================================================================== session */

function LaunchSession({ open, place }: { open: boolean; place: Place }) {
  const closeModal = useStore((s) => s.closeModal);
  const wallet = useStore((s) => s.wallet.address);
  const balance = useStore((s) => s.solBalance);
  const online = useStore((s) => s.online);
  const provider = useStore((s) => s.provider);
  const phoneOff = usePhoneOff();
  const h = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const init = useMemo(() => initialDraft(place), [place]);
  const [step, setStep] = useState<Step>('details');
  const [name, setName] = useState(init.name);
  const [ticker, setTicker] = useState(init.ticker);
  const [tickerEdited, setTickerEdited] = useState(init.tickerEdited);
  const [nameEdited, setNameEdited] = useState(init.nameEdited);
  const [category, setCategory] = useState<CategoryKey>(init.category);
  const [emoji, setEmoji] = useState(init.emoji);
  const [bg, setBg] = useState(init.bg);
  const [upload, setUpload] = useState<string | null>(init.upload);
  const [devBuy, setDevBuy] = useState(init.devBuy);
  const [touched, setTouched] = useState({ name: false, ticker: false });
  const [attempted, setAttempted] = useState(false);
  const [artError, setArtError] = useState<string | null>(null);
  const [artBusy, setArtBusy] = useState(false);
  const [displayName, setDisplayName] = useState<string | null>(place.name || null);
  const [agree, setAgree] = useState(false);
  const [signinNotice, setSigninNotice] = useState<string | null>(null);
  const [runIdx, setRunIdx] = useState(0);
  const [launchedId, setLaunchedId] = useState<string | null>(null);
  const [firstBuy, setFirstBuy] = useState<TradeResult | null>(null);
  const [taken, setTaken] = useState<Coin | null>(null);
  /* real mode */
  const balanceLamports = useStore((s) => s.balanceLamports);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [inelig, setInelig] = useState<LaunchIneligibleReason | null>(null);
  const [progress, setProgress] = useState<TxProgress | null>(null);
  const [txError, setTxError] = useState<TxError | null>(null);
  const [cost, setCost] = useState<LaunchCostEstimate | null>(null);
  const [costErr, setCostErr] = useState(false);
  const [realFirstBuy, setRealFirstBuy] = useState<TradeFill | null>(null);
  const [launchSig, setLaunchSig] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState<string | null>(null);
  const [takenRef, setTakenRef] = useState<TakenRef | null>(null);
  const launching = useRef(false);
  const timers = useRef<number[]>([]);
  const alive = useRef(true);
  const categoryTouched = useRef(false);
  const launchedCoin = useStore((s) => (launchedId ? s.coins[launchedId] : undefined));
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    alive.current = true;
    if (IS_REAL) prefetchChain();
    return () => {
      alive.current = false;
      timers.current.forEach((t) => clearTimeout(t));
      timers.current = [];
      if (IS_REAL && !launching.current) clearTx('launch');
    };
  }, []);
  const later = (fn: () => void, ms: number) => {
    const t = window.setTimeout(() => {
      timers.current = timers.current.filter((x) => x !== t);
      if (alive.current) fn();
    }, ms);
    timers.current.push(t);
  };

  /* ---------------- draft memory: save on close (unless launched), so reopening restores it */
  const draftRef = useRef<LaunchDraftState | null>(null);
  draftRef.current = { name, ticker, tickerEdited, nameEdited, description: '', category, emoji, bg, upload, devBuy };
  useEffect(() => {
    if (open) return;
    if (launchedId || !draftRef.current) return;
    const d = draftRef.current;
    if (d.nameEdited || d.tickerEdited || d.upload) saveDraft(place.id, d);
  }, [open, launchedId, place.id]);

  /* ---------------- Google prefill: displayName (h2 + name prefill) and category */
  useEffect(() => {
    if (place.source !== 'google') return;
    let on = true;
    const hadDraft = !!getDraft(place.id);
    getLaunchPrefill(place.id)
      .then((r) => {
        if (!on) return;
        const cur = draftRef.current;
        if (r.displayName) {
          setDisplayName(r.displayName);
          if (!hadDraft && cur && !cur.name && !cur.nameEdited) {
            const next = r.displayName.slice(0, LIMITS.nameMax);
            setName(next);
            if (!cur.tickerEdited) setTicker(tickerFromName(next));
          }
        }
        if (!hadDraft && !categoryTouched.current && isCategoryKey(r.category) && r.category !== 'other') {
          const cat = r.category;
          setCategory(cat);
          const set = categoryDef(cat).stickers;
          if (cur && !set.includes(cur.emoji)) setEmoji(set[0] ?? cur.emoji);
        }
      })
      .catch(() => {
        /* no prefill: the launcher types the name */
      });
    return () => {
      on = false;
    };
  }, [place]);

  /* ---------------- wallet changes mid-flow */
  useEffect(() => {
    if (step === 'signin' && wallet) {
      setSigninNotice(null);
      setStep('review');
    } else if (step === 'review' && !wallet) {
      setSigninNotice(WALLET_GONE);
      setStep('signin');
    }
  }, [step, wallet]);

  /* ---------------- focus the new step (heading or first field) */
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    const root = bodyRef.current;
    const target = root?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)') ?? root?.querySelector<HTMLElement>('h2');
    target?.focus({ preventScroll: true });
    root?.closest('.dialog')?.scrollTo({ top: 0 });
  }, [step]);

  /* ---------------- derived */
  const def = categoryDef(category);
  const stickers = def.stickers;
  const logo: LogoSpec = upload ? { kind: 'upload', dataUrl: upload, emoji, bg } : { kind: 'sticker', emoji, bg };
  const trimmed = name.trim();
  const nameErr = trimmed ? null : 'Give your coin a name';
  const tickerErr = validateTicker(ticker) ? TICKER_ERROR_MESSAGE : null;
  const showNameErr = touched.name || attempted ? nameErr : null;
  const showTickerErr = touched.ticker || attempted ? tickerErr : null;
  const taken2 = useStore((s) => !tickerErr && isTickerTaken(ticker, Object.values(s.coins), place.id));
  const tickerWarn = taken2 ? `$${ticker} is already used by another shop. You can still use it.` : null;
  const devBuySol = Number(devBuy) || 0;
  const devBuyLamports = parseSol(devBuy) ?? 0n;
  const title = displayName ? `Launch a coin for ${displayName}` : 'Launch a coin for this shop';
  // demo: the whole run is busy; real: only once the tx is out (preparing / wallet prompt can close)
  const busy = IS_REAL ? step === 'launching' && isBusyPhase(progress) : step === 'launching';
  const short = IS_REAL && cost ? shortfall(cost.totalLamports, balanceLamports) : null;

  /* ---------------- real: cost estimate + fresh balance on Review */
  useEffect(() => {
    if (!IS_REAL || step !== 'review') return;
    let on = true;
    setCost(null);
    setCostErr(false);
    void loadWallet().catch(() => {});
    chain()
      // exact figure (verified equal to the actual spend on devnet): real name/ticker lengths + the launcher's accounts
      .then((api) => api.estimateLaunchCost(devBuyLamports, { name: name.trim().normalize('NFC'), symbol: ticker, launcher: wallet ?? undefined }))
      .then((c) => on && setCost(c))
      .catch(() => on && setCostErr(true));
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, devBuy, wallet]);

  /* ---------------- handlers */
  const close = () => {
    if (busy) return;
    const coinNow = launchedId ? useStore.getState().coins[launchedId] : undefined;
    closeModal();
    if (step === 'success' && coinNow) finishLaunch(coinNow);
  };

  const finishLaunch = (coin: Coin, opts: { fly?: boolean } = {}) => {
    const st = useStore.getState();
    if (st.panel !== 'place' || st.selected.place?.id !== coin.placeId || opts.fly) {
      st.openPlace(placeFromCoin(coin), { fly: true });
    } else if (st.panelCollapsed) st.setPanelCollapsed(false);
    st.toast(IS_REAL ? `$${coin.ticker} launched` : `$${coin.ticker} launched · Demo`, 'ok', {
      label: 'Share',
      run: () => useStore.getState().openModal({ kind: 'share', placeId: coin.placeId, variant: 'launched' }),
    });
  };

  const onName = (v: string) => {
    setName(v);
    setNameEdited(true);
    if (!tickerEdited) setTicker(tickerFromName(v));
  };

  const onCategory = (v: string) => {
    if (!isCategoryKey(v)) return;
    categoryTouched.current = true;
    setCategory(v);
    const next = categoryDef(v).stickers;
    if (!next.includes(emoji)) setEmoji(next[0] ?? categoryDef(v).emoji);
  };

  const pickSticker = (e: string) => {
    setEmoji(e);
    setUpload(null);
    setArtError(null);
  };


  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setArtError(null);
    if (!ART_TYPES.test(file.type) || file.size > LIMITS.artMaxBytes) {
      setArtError(ART_ERROR);
      return;
    }
    setArtBusy(true);
    try {
      const url = await fileToSquareDataUrl(file, LIMITS.artMaxPx);
      if (alive.current) setUpload(url);
    } catch {
      if (alive.current) setArtError(ART_ERROR);
    } finally {
      if (alive.current) setArtBusy(false);
    }
  };

  /** Show the taken screen for a coin we may not have loaded yet. */
  const showTaken = (ref: TakenRef | null | undefined) => {
    const st = useStore.getState();
    const c = st.coins[place.id] ?? (ref ? Object.values(st.coins).find((x) => x.mint === ref.mint) : undefined);
    setTaken(c ?? null);
    setTakenRef(c ? null : (ref ?? null));
    setStep('taken');
  };

  const onContinue = async () => {
    setAttempted(true);
    if (nameErr || tickerErr || artBusy || checking) return;
    const st = useStore.getState();
    const existing = st.coins[place.id];
    if (existing) {
      setTaken(existing);
      setStep('taken');
      return;
    }
    setCheckErr(null);
    if (IS_REAL) {
      // the Worker asks Google: open business? already a coin? (INTEGRATION.md §7.4)
      prefetchPump();
      setChecking(true);
      try {
        const r = isDevTestPlaceId(place.id) ? null : await checkEligibility(place.id);
        if (!alive.current) return;
        if (r && !r.launchable) {
          if (r.reason === 'taken') {
            const pr = await ensurePlace(place.id).catch(() => null);
            if (!alive.current) return;
            showTaken(pr?.coin ? { placeId: pr.coin.placeId, mint: pr.coin.mint, ticker: pr.coin.ticker } : null);
            return;
          }
          setInelig(r.reason === 'ok' ? 'not_business' : r.reason);
          setStep('ineligible');
          return;
        }
      } catch (e) {
        if (alive.current) setCheckErr(apiErrorMessage(e, "We couldn't check this place right now. Try again."));
        return;
      } finally {
        if (alive.current) setChecking(false);
      }
    } else if (place.source === 'google') {
      // demo: plus codes, cities, roads, regions and closed businesses can't get a coin either
      let reason = knownIneligibility(place);
      if (!reason) {
        setChecking(true);
        const pre = await getLaunchPrefill(place.id).catch(() => null);
        if (!alive.current) return;
        setChecking(false);
        if (pre?.facts) reason = ineligibilityFromFacts(pre.facts);
      }
      if (reason && reason !== 'taken') {
        setInelig(reason);
        setStep('ineligible');
        return;
      }
    }
    setStep(useStore.getState().wallet.address ? 'review' : 'signin');
  };

  /** Real launch (INTEGRATION.md §4.4): art → chain.launchCoin with tx phases. */
  const runRealLaunch = async () => {
    if (launching.current) return;
    launching.current = true;
    setStep('launching');
    setProgress({ phase: 'preparing', step: 'metadata' });
    setTxError(null);
    setReviewNote(null);
    let image: Blob;
    try {
      image = upload ? await encodeUpload(upload) : await renderSticker(emoji, bg);
    } catch (e) {
      launching.current = false;
      if (!alive.current) return;
      setTxError({ code: 'unknown', message: e instanceof Error && e.message ? e.message : "We couldn't prepare the coin art. Try again.", retryable: true, sent: false });
      setStep('failed');
      return;
    }
    const input: LaunchInput = { placeId: place.id, name: trimmed, ticker, description: '', category, emoji, bg, image, devBuyLamports };
    // closing the modal before the wallet prompt cancels the launch: nothing is signed or sent
    const wrapSigner = (sig: WalletSigner): WalletSigner => ({
      ...sig,
      signTransaction: (bytes) => (openRef.current ? sig.signTransaction(bytes) : Promise.reject(userCancelled())),
    });
    const out = await runTx('launch', place.id, async (signer, onProgress) => (await chain()).launchCoin(input, signer, onProgress), {
      onProgress: (p) => {
        if (alive.current) setProgress(p);
      },
      wrapSigner,
    });
    launching.current = false;
    const st = useStore.getState();
    if (out.ok) {
      const [coin] = ingestCoins([out.value.coin], st.solUsd);
      clearDraft(place.id);
      void refreshAfterTx('launch', out.value.mint);
      if (!coin) return;
      if (!alive.current || !openRef.current) {
        finishLaunch(coin);
        return;
      }
      setLaunchedId(coin.placeId);
      setRealFirstBuy(out.value.devBuy);
      setLaunchSig(out.signature);
      setProgress({ phase: 'done' });
      setStep('success');
      return;
    }
    const err = out.error;
    if (err.code === 'rejected') {
      clearTx('launch');
      if (alive.current && openRef.current) {
        setReviewNote(err.message);
        setStep('review');
      }
      return;
    }
    if (err.code === 'taken') {
      if (alive.current && openRef.current) showTaken(err.existing ?? null);
      else st.toast(err.existing ? `This shop already has a coin — $${err.existing.ticker}` : 'Someone launched this shop first', 'error');
      return;
    }
    if (!alive.current || !openRef.current) {
      st.toast(`Launch failed. ${err.message}`, 'error', err.signature ? { label: 'View tx', run: () => openExternal(err.explorerUrl ?? explorerTx(err.signature ?? '')) } : undefined);
      return;
    }
    setTxError(err);
    setStep('failed');
  };

  const runLaunch = () => {
    if (IS_REAL) {
      void runRealLaunch();
      return;
    }
    if (busy) return;
    setStep('launching');
    setRunIdx(0);
    later(() => {
      if (!useStore.getState().online) {
        setStep('failed');
        return;
      }
      setRunIdx(1);
      later(() => {
        const st = useStore.getState();
        const draft: LaunchDraft = {
          place,
          name: trimmed,
          ticker,
          description: '',
          category,
          logo,
          devBuySol,
        };
        const r = st.launchCoin(draft);
        if (!r.ok) {
          if (r.reason === 'taken') {
            setTaken(r.existing);
            setStep('taken');
          } else if (r.reason === 'no-wallet') {
            setSigninNotice(WALLET_GONE);
            setStep('signin');
          } else setStep('failed');
          return;
        }
        clearDraft(place.id);
        // an owner who verified this place before it had a coin gets it straight away
        const pre = getPreClaim(place.id);
        if (pre) {
          const c = useStore.getState().claimFees(place.id, pre.payoutWallet, { owner: pre.owner });
          if (c.ok) clearPreClaim(place.id);
        }
        setLaunchedId(r.coin.placeId);
        setFirstBuy(r.firstBuy);
        setRunIdx(2);
        const launched = r.coin;
        later(() => {
          setRunIdx(3);
          later(() => {
            // closed by browser Back mid-launch (bypasses the busy guard): still confirm it
            if (!openRef.current) {
              const c = useStore.getState().coins[launched.placeId] ?? launched;
              finishLaunch(c);
            }
            setStep('success');
          }, 250);
        }, STEP_MS);
      }, STEP_MS);
    }, STEP_MS);
  };

  /* ---------------- render steps */
  const shown = launchedCoin;
  // Which place this coin is for (DESIGN §9.5: Details step header and Review): Google's compact
  // element for real places, the fictional lookalike for demo shops.
  const placeCompact =
    place.source === 'google' ? (
      provider === 'google' ? (
        <GooglePlaceCompact placeId={place.id} />
      ) : null
    ) : (
      <DemoPlaceCompact place={place} />
    );
  let body: ReactNode;
  switch (step) {
    case 'details':
      body = (
        <>
          <h2 id={h} tabIndex={-1}>
            {title}
          </h2>
          <p className="dlg-sub">One coin per place — first launch wins. You can't change the name or ticker later.</p>
          {placeCompact}
          <div className="art-row">
            <div className="art-wrap">
              <button
                type="button"
                className={['art', upload ? 'has-img' : ''].filter(Boolean).join(' ')}
                aria-label={upload ? 'Change coin art' : 'Upload coin art'}
                aria-describedby={artError ? `${h}-art` : undefined}
                onClick={() => fileRef.current?.click()}
                disabled={artBusy}
              >
                {artBusy ? (
                  <Spinner size={24} label="Processing image" />
                ) : upload ? (
                  <img src={upload} alt={`${trimmed || 'Coin'} coin art`} />
                ) : (
                  <>
                    <Icon name="add_photo_alternate" />
                    <small>Coin art</small>
                  </>
                )}
              </button>
              {upload ? (
                <button
                  type="button"
                  className="art-x hit"
                  aria-label="Remove coin art"
                  onClick={() => {
                    setUpload(null);
                    setEmoji(stickers[0] ?? emoji);
                  }}
                >
                  <Icon name="close" size={16} />
                </button>
              ) : null}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => void onFile(e)} />
            </div>
            <div className="emoji-pick">
              <span className="lbl2">or pick a sticker</span>
              <div role="radiogroup" aria-label="Sticker">
                {stickers.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={!upload && s === emoji}
                    aria-label={`Sticker ${s}`}
                    className={['hit', !upload && s === emoji ? 'on' : ''].filter(Boolean).join(' ')}
                    onClick={() => pickSticker(s)}
                  >
                    <span aria-hidden="true">{s}</span>
                  </button>
                ))}
              </div>
              <span className="lbl2 lf-colour-l">Colour</span>
              <div className="swatches" role="radiogroup" aria-label="Colour">
                {COIN_SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={c === bg}
                    aria-label={`Colour ${c}`}
                    className={['swatch', 'hit', c === bg ? 'on' : ''].filter(Boolean).join(' ')}
                    style={{ background: c }}
                    onClick={() => setBg(c)}
                  />
                ))}
              </div>
            </div>
          </div>
          {artError ? (
            <p id={`${h}-art`} className="tf-help err lf-art-err" role="alert">
              {artError}
            </p>
          ) : null}
          <TextField
            label="Coin name"
            value={name}
            maxLength={LIMITS.nameMax}
            counter
            autoComplete="off"
            onChange={(e) => onName(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
            error={showNameErr}
            data-autofocus
          />
          <div className="tf-row">
            <TextField
              label="Ticker"
              prefix="$"
              value={ticker}
              maxLength={LIMITS.tickerMax}
              counter
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="lf-ticker"
              translate="no"
              onChange={(e) => {
                setTicker(sanitizeTicker(e.target.value));
                setTickerEdited(true);
              }}
              onBlur={() => setTouched((t) => ({ ...t, ticker: true }))}
              error={showTickerErr}
              warn={tickerWarn}
            />
            <SelectField
              label="Category"
              value={category}
              options={CATEGORY_OPTIONS.map((o) => ({ value: o.key, label: o.label }))}
              onChange={(e) => onCategory(e.target.value)}
            />
          </div>
          <div className="dlg-box">
            <Icon name="payments" fill />
            <div>
              <b>100% of creator fees → held for this shop</b>
              <small>
                Unclaimed · not affiliated with this business.{' '}
                {phoneOff ? "The owner claims with a code on the shop's own website." : 'The owner claims by phone verification.'}
              </small>
            </div>
          </div>
          <div className="dlg-buy">
            <span id={`${h}-buy`}>First buy (optional)</span>
            <Seg options={BUY_OPTIONS} value={devBuy} onChange={setDevBuy} ariaLabel="First buy" />
          </div>
          {checkErr ? (
            <p className="tf-help err" role="alert">
              {checkErr}
            </p>
          ) : null}
          <ModalFooter>
            <Button variant="text" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!!showNameErr || !!showTickerErr || artBusy} loading={checking} onClick={() => void onContinue()}>
              {checking ? 'Checking…' : 'Continue'}
            </Button>
          </ModalFooter>
        </>
      );
      break;

    case 'signin':
      body = (
        <>
          <WalletPicker
            title="Sign in to launch"
            sub={
              IS_REAL
                ? "You'll be listed as the launcher. Your wallet will ask you to approve the launch."
                : "You'll be listed as the launcher. In the demo nothing is signed or sent."
            }
            headingId={h}
            notice={signinNotice}
            onConnected={() => {
              setSigninNotice(null);
              setStep('review');
            }}
          />
          <ModalFooter>
            <Button variant="text" onClick={() => setStep('details')}>
              Back
            </Button>
          </ModalFooter>
        </>
      );
      break;

    case 'review': {
      const buyShown = devBuySol > 0 ? solAmount(devBuySol) : 'None';
      const demoShort = !IS_REAL && devBuySol > 0 && devBuySol > balance + 1e-9;
      const feeShown = !IS_REAL
        ? `~${solNumber(NETWORK_FEE_SOL)} SOL (simulated)`
        : cost
          ? `≈ ${solCeil(cost.rentLamports + cost.feeLamports, 4)} SOL`
          : costErr
            ? 'Unavailable'
            : '…';
      body = (
        <>
          <h2 id={h} tabIndex={-1}>
            Review your coin
          </h2>
          <p className="dlg-sub">The name and ticker are permanent.</p>
          <div className="lf-sum">
            <Sticker logo={logo} size={56} alt={`${trimmed} coin art`} />
            <div className="lf-sum-tx">
              <span className="ticker ghost" translate="no">
                ${ticker}
              </span>
              <b>{trimmed}</b>
              <small>{categoryLabel(category)}</small>
            </div>
          </div>
          <p className="lbl2 lf-place-l">Place</p>
          {placeCompact}
          <div className="dlg-box green">
            <Icon name="rocket_launch" fill />
            <span className="lf-oneline">Launchpad: pump.fun · Creator fees → this shop's vault (100%)</span>
          </div>
          <dl className="lf-rows">
            <div>
              <dt>Network</dt>
              <dd>{IS_REAL && CLUSTER === 'devnet' ? 'Solana devnet' : 'Solana'}</dd>
            </div>
            {IS_REAL ? (
              <div>
                <dt>Network fee + rent</dt>
                <dd>{feeShown}</dd>
              </div>
            ) : null}
            <div>
              <dt>First buy</dt>
              <dd>{buyShown}</dd>
            </div>
            <div>
              <dt>Platform cut</dt>
              <dd>0%</dd>
            </div>
            {IS_REAL ? null : (
              <div>
                <dt>Network fee</dt>
                <dd>{feeShown}</dd>
              </div>
            )}
          </dl>
          {demoShort ? (
            <p className="tf-help warn lf-short">
              Your balance is {solAmount(balance)}, so the first buy will use {solAmount(balance)}.
            </p>
          ) : null}
          {short ? (
            <div className="tx-short lf-short" role="status">
              <b>{short.message}</b>
              {CLUSTER === 'devnet' ? (
                <span className="tx-short-a">
                  <button type="button" className="link hit" onClick={() => void getTestSol()}>
                    Get test SOL
                  </button>
                </span>
              ) : (
                <span>Add SOL to your wallet to continue</span>
              )}
            </div>
          ) : null}
          {costErr ? (
            <p className="tf-help err lf-short" role="alert">
              We couldn't estimate the network fee. Check your connection and try again.
            </p>
          ) : null}
          {reviewNote ? (
            <p className="tf-help err lf-short" role="alert">
              {reviewNote}
            </p>
          ) : null}
          <Checkbox checked={agree} onChange={(e) => setAgree(e.target.checked)}>
            I understand this coin isn't affiliated with the business and anyone can trade it.
          </Checkbox>
          <ModalFooter>
            <Button variant="text" onClick={() => setStep('details')}>
              Back
            </Button>
            <Button
              variant="primary"
              icon="rocket_launch"
              iconFill
              disabled={!agree || !online || (IS_REAL && (!cost || !!short))}
              tip={!online ? "You're offline" : undefined}
              onClick={runLaunch}
            >
              <span translate="no">Launch ${ticker}</span>
            </Button>
          </ModalFooter>
        </>
      );
      break;
    }

    case 'launching': {
      // real: rows follow the tx phases (INTEGRATION.md §7.3, "Launch modal step 4a")
      const ph = progress?.phase ?? 'preparing';
      const chainDone = ph === 'registering' || ph === 'done';
      const realState = (i: number) => (ph === 'done' ? 'done' : chainDone ? (i < 2 ? 'done' : 'run') : i === 0 ? 'run' : 'todo');
      const helper = IS_REAL ? phaseHelper(progress) : null;
      body = (
        <>
          <h2 id={h} tabIndex={-1} translate="no">
            Launching ${ticker}…
          </h2>
          <ol className="lf-run" aria-live="polite">
            {RUN_ROWS.map((label, i) => {
              // the coin and the fee routing are one atomic tx: rows 1 and 2 finish together
              const state = IS_REAL ? realState(i) : i < runIdx ? 'done' : i === runIdx ? 'run' : 'todo';
              const sub = IS_REAL && state === 'run' ? phaseLabel(progress, 'launch') : null;
              return (
                <li key={label} className={`is-${state}`}>
                  {state === 'done' ? (
                    <Icon name="check_circle" fill />
                  ) : state === 'run' ? (
                    <Spinner size={20} />
                  ) : (
                    <span className="lf-dot" aria-hidden="true" />
                  )}
                  <span>
                    {label}
                    {sub ? <small className="tx-sub">{sub}</small> : null}
                  </span>
                  {state === 'done' ? <span className="sr">done</span> : null}
                </li>
              );
            })}
          </ol>
          {helper ? <p className="tx-help">{helper}</p> : null}
          <ModeNote />
        </>
      );
      break;
    }

    case 'success': {
      const coin = shown;
      const url = coin ? links.shareCoin(coin.mint) : '';
      body = coin ? (
        <div className="dlg-center lf-success">
          <span className="lf-big">
            <Sticker logo={coin.logo} size={96} alt={`${coin.name} coin art`} />
            <i className="lf-ring" aria-hidden="true" />
            <i className="lf-ring r2" aria-hidden="true" />
          </span>
          <h2 id={h} tabIndex={-1} translate="no">
            ${coin.ticker} is live
          </h2>
          <p className="dlg-sub">You launched the first coin for this shop. Every trade now builds fees for the owner.</p>
          {IS_REAL && realFirstBuy ? (
            <p className="lf-fb" translate="no">
              First buy: {solAmount(Number(realFirstBuy.lamports) / 1e9)} → {realFirstBuy.estimated ? '≈ ' : ''}
              {tokenAmount(unitsToTokens(realFirstBuy.tokens))} ${coin.ticker}
            </p>
          ) : !IS_REAL && firstBuy ? (
            <p className="lf-fb" translate="no">
              First buy: {solAmount(firstBuy.sol)} → {tokenAmount(firstBuy.tokens)} ${coin.ticker}
            </p>
          ) : null}
          <div className="lf-succ-btns">
            <Button variant="primary" lead={<XGlyph />} onClick={() => postOnX(sharePostText('launched', coin), url)} data-autofocus>
              Share on X
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                closeModal();
                finishLaunch(coin, { fly: true });
              }}
            >
              View coin
            </Button>
          </div>
          <p className="lf-owner">Know the owner? Send them this page so they can claim the fees.</p>
          <Button variant="text" icon="link" onClick={() => void copyWithToast(url, 'Link copied')}>
            Copy link
          </Button>
          {IS_REAL && launchSig ? (
            <Button variant="text" icon="open_in_new" onClick={() => openExternal(explorerTx(launchSig))}>
              View launch tx
            </Button>
          ) : null}
          <ModeNote />
        </div>
      ) : (
        <p className="dlg-sub">Launched.</p>
      );
      break;
    }

    case 'taken': {
      const other: { ticker: string } | null = taken ?? takenRef;
      body = (
        <div className="dlg-center lf-err">
          <span className="lf-err-ic warn">
            <Icon name="warning" />
          </span>
          <h2 id={h} tabIndex={-1}>
            Someone launched this shop first
          </h2>
          <p className="dlg-sub" translate="no">
            This place now has ${other?.ticker ?? ''}. One coin per place.
          </p>
          <div className="lf-succ-btns">
            <Button
              variant="primary"
              data-autofocus
              onClick={() => {
                closeModal();
                if (taken) useStore.getState().openPlace(placeFromCoin(taken), { fly: true });
                else if (takenRef) {
                  void findCoinByMint(takenRef.mint)
                    .then((c) => {
                      if (c) useStore.getState().openPlace(placeFromCoin(c), { fly: true });
                    })
                    .catch(() => useStore.getState().toast("We couldn't open that coin. Try again.", 'error'));
                }
              }}
            >
              <span translate="no">View ${other?.ticker ?? ''}</span>
            </Button>
            <Button variant="outline" onClick={closeModal}>
              Close
            </Button>
          </div>
        </div>
      );
      break;
    }

    case 'ineligible':
      body = (
        <div className="dlg-center lf-err">
          <span className="lf-err-ic warn">
            <Icon name="block" />
          </span>
          <h2 id={h} tabIndex={-1}>
            This place can't have a coin
          </h2>
          <p className="dlg-sub">
            {inelig === 'opted_out'
              ? "This business asked us not to list coins for it, so it can't be launched."
              : inelig === 'closed'
                ? 'This business is marked as closed on Google.'
                : 'Only open businesses can be launched.'}
          </p>
          <div className="lf-succ-btns">
            <Button
              variant="primary"
              icon="search"
              data-autofocus
              onClick={() => {
                const st = useStore.getState();
                closeModal();
                st.closePanel();
                st.focusSearch();
              }}
            >
              Find a shop
            </Button>
            <Button variant="outline" onClick={closeModal}>
              Close
            </Button>
          </div>
        </div>
      );
      break;

    case 'failed':
    default: {
      const err = IS_REAL ? txError : null;
      const sig = err?.signature ?? null;
      const msg = err ? (err.code === 'insufficient-sol' ? insufficientMessage(err) : err.message) : 'Nothing was sent. You can try again.';
      const canRetry = !err || err.retryable || err.code === 'insufficient-sol';
      body = (
        <div className="dlg-center lf-err">
          <span className="lf-err-ic bad">
            <Icon name="error" />
          </span>
          <h2 id={h} tabIndex={-1}>
            Launch failed
          </h2>
          <p className="dlg-sub">{msg}</p>
          <div className="lf-succ-btns">
            {canRetry ? (
              <Button variant="primary" icon="refresh" onClick={runLaunch} disabled={!online} tip={!online ? "You're offline" : undefined} data-autofocus>
                Try again
              </Button>
            ) : null}
            {err?.code === 'insufficient-sol' && CLUSTER === 'devnet' ? (
              <Button variant="outline" icon="water_drop" onClick={() => void getTestSol()}>
                Get test SOL
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setStep('review')} data-autofocus={canRetry ? undefined : true}>
              Back to review
            </Button>
          </div>
          {sig ? (
            <Button variant="text" icon="open_in_new" onClick={() => openExternal(err?.explorerUrl ?? explorerTx(sig))}>
              View tx
            </Button>
          ) : null}
        </div>
      );
      break;
    }
  }

  return (
    <Modal open={open} onClose={close} labelledBy={h} busy={busy} className="launch-dlg">
      <ModalHeader steps={{ labels: STEP_LABELS, current: STEP_INDEX[step] }} onClose={close} closeDisabled={busy} />
      <div ref={bodyRef}>
        <ModalStep stepKey={step}>{body}</ModalStep>
      </div>
    </Modal>
  );
}
