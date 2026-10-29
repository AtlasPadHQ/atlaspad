/**
 * First-visit hero card over the live map (DESIGN §11; copy verbatim from BRIEF, lowercase).
 * Visible while !store.heroDismissed (localStorage `cs_hero_seen`, try/catch in the store; if
 * storage is unavailable it shows once per page session).
 *
 *  - close (`Dismiss`) → dismiss.
 *  - paste form → `try now`:
 *      a Google Maps link → resolve (spinner, input read-only) → dismiss → open the place
 *      (launchable: the launch modal opens too); search links fill the search box; map-only
 *      links fly there. If the resolver is unreachable but the link carries a location, the
 *      unresolved place (placeFromParsedLink) is opened so the user still lands on it.
 *      Errors show inline: `That doesn't look like a Google Maps link.` /
 *      `Couldn't find that place. Copy the link from Share in Google Maps.`
 *      An empty input → dismiss and focus the search box with the link tip open (DESIGN §18.3).
 *  - `Live coins` chip → dismiss + Live coins filter; `Near me` chip → dismiss + locate.
 *  - stats: live shop count, fees waiting for owners, 0% platform cut.
 * Desktop: card at left 88 / top 72 (tablet top 116). Mobile: bottom sheet; dragging the handle
 * down > 80px dismisses. Reduced motion: no animations. OWNED BY RAIL+FEED.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { usdCompactFloor } from '../lib/format';
import { useIsMobile } from '../lib/media';
import { placeFromParsedLink } from '../places';
import { looksLikeMapsLink, parseMapsLink } from '../search/parseMapsLink';
import { nearMe as runNearMe } from '../search/actions';
import { openResolvedLink, resolveErrorMessage, resolveMapsLink } from '../search/resolveLink';
import { IS_REAL } from '../mode';
import { lamportsToUsdFloor } from '../realdata/units';
import { totals, useShallow, useStore } from '../store';
import type { ParsedMapsLink, ResolvedLink } from '../types';
import { Brand, Button, Icon, usePresence } from '../ui';
import './hero.css';

const ERR_LINK = "That doesn't look like a Google Maps link.";
const DRAG_DISMISS_PX = 80;

export default function Hero() {
  const dismissed = useStore((s) => s.heroDismissed);
  const mobile = useIsMobile();
  const { mounted, state } = usePresence(!dismissed, mobile ? 300 : 200);
  if (!mounted) return null;
  return <HeroCard state={state} mobile={mobile} />;
}

/** Empty `try now` (DESIGN §18.3): dismiss the hero and focus search with the link tip shown. */
function openSearchTip(): void {
  const s = useStore.getState();
  s.dismissHero();
  s.focusSearch({ tip: true });
}

function HeroCard({ state, mobile }: { state: 'open' | 'closing' | 'closed'; mobile: boolean }) {
  const dismissHero = useStore((s) => s.dismissHero);
  const stats = useStore(
    useShallow((s) => {
      // real mode: the Worker's global numbers when it sends them (optional `stats` on /api/config);
      // otherwise the registry snapshot loaded on boot (top 300 by market cap + the viewport)
      const g = (s.chain.config as { stats?: { coins?: number; feesWaitingLamports?: string } } | null)?.stats;
      if (IS_REAL && g && typeof g.coins === 'number') {
        return { shops: g.coins, fees: lamportsToUsdFloor(g.feesWaitingLamports ?? '0', s.solUsd) };
      }
      const t = totals(s.coins, s.solUsd);
      return { shops: t.shops, fees: t.feesWaitingUsd };
    }),
  );
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const seq = useRef(0);
  const alive = useRef(true);
  const titleId = useId();
  const errId = useId();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Dismiss and keep keyboard focus somewhere sensible (the map) if it was inside the card. */
  const dismiss = () => {
    seq.current++; // drop any link that is still resolving
    const inside = cardRef.current?.contains(document.activeElement) ?? false;
    dismissHero();
    if (inside) document.getElementById('map')?.focus({ preventScroll: true });
  };

  const handleResult = (res: ResolvedLink, parsed: ParsedMapsLink | null) => {
    const s = useStore.getState();
    if (res.status !== 'error') {
      // Same behaviour as the search bar's link row (SEARCH openResolvedLink): place → fly + panel
      // (+ launch modal when launchable and coin-less; a launched place opens its coin) · search link
      // → results list · map-only link → fly there + toast. The hero goes away in every case.
      s.dismissHero();
      openResolvedLink(res, { launch: true });
      return;
    }
    if (res.error === 'network' && parsed?.location) {
      // resolver unreachable: open the unresolved place from the link itself
      s.openPlace(placeFromParsedLink(parsed), { fly: true, from: null });
      return;
    }
    setError(resolveErrorMessage(res.error));
    inputRef.current?.focus();
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const text = value.trim();
    if (!text) {
      seq.current++;
      openSearchTip();
      return;
    }
    if (!looksLikeMapsLink(text)) {
      setError(ERR_LINK);
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    const my = ++seq.current;
    let parsed: ParsedMapsLink | null = null;
    try {
      parsed = parseMapsLink(text);
    } catch {
      parsed = null;
    }
    let res: ResolvedLink;
    try {
      res = await resolveMapsLink(parsed ?? text);
    } catch {
      res = { status: 'error', error: 'network' };
    }
    if (!alive.current || my !== seq.current) return;
    setBusy(false);
    handleResult(res, parsed);
  };

  const liveCoins = () => {
    const s = useStore.getState();
    s.dismissHero();
    s.setCategory('live');
  };

  const nearMe = () => {
    useStore.getState().dismissHero();
    void runNearMe();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      dismiss();
    }
  };

  /* ---------------- mobile: drag the handle down > 80px to dismiss */
  const drag = useRef<{ y0: number; dy: number; id: number } | null>(null);
  const setOffset = (dy: number) => {
    const el = cardRef.current;
    if (el) el.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  };
  const onGrabDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!mobile || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { y0: e.clientY, dy: 0, id: e.pointerId };
    cardRef.current?.classList.remove('settling');
    cardRef.current?.classList.add('dragging');
  };
  const onGrabMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.dy = Math.max(0, e.clientY - d.y0);
    setOffset(d.dy);
  };
  const onGrabEnd = () => {
    const d = drag.current;
    drag.current = null;
    const el = cardRef.current;
    if (!d || !el) return;
    el.classList.remove('dragging');
    if (d.dy > DRAG_DISMISS_PX) {
      el.style.setProperty('--hero-drag', `${d.dy}px`);
      dismiss();
      return;
    }
    el.classList.add('settling');
    setOffset(0);
  };

  return (
    <section
      ref={cardRef}
      className="herocard"
      data-state={state}
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onTransitionEnd={() => cardRef.current?.classList.remove('settling')}
    >
      <div
        className="hero-grab"
        aria-hidden="true"
        onPointerDown={onGrabDown}
        onPointerMove={onGrabMove}
        onPointerUp={onGrabEnd}
        onPointerCancel={onGrabEnd}
      />
      <button type="button" className="close hit" aria-label="Dismiss" data-tip="Dismiss" onClick={dismiss}>
        <Icon name="close" />
      </button>
      <Brand iconSize={32} />
      <h1 id={titleId}>
        your cafe. your barber. <span>your kebab shop.</span>
      </h1>
      <p>
        launch a coin for any business on earth. <b>100% of creator fees are held for the shop's verified owner.</b>
      </p>
      <p className="hero-p2">paste a google maps link. launch. done.</p>
      <form className={['paste', error ? 'err' : ''].filter(Boolean).join(' ')} onSubmit={onSubmit} noValidate>
        <Icon name="link" />
        <input
          ref={inputRef}
          type="text"
          inputMode="url"
          enterKeyHint="go"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="paste a google maps link"
          aria-label="Paste a Google Maps link"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          value={value}
          readOnly={busy}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
        />
        <Button type="submit" variant="primary" loading={busy}>
          try now
        </Button>
      </form>
      {error ? (
        <p className="hero-err" id={errId} role="alert">
          {error}
        </p>
      ) : null}
      <div className="hero-or">
        or tap any shop on the map
        <button type="button" className="chip hit" onClick={liveCoins}>
          <span className="em" aria-hidden="true">
            🔥
          </span>
          Live coins
        </button>
        <button type="button" className="chip hit" onClick={nearMe}>
          <Icon name="near_me" />
          Near me
        </button>
      </div>
      <div className="hero-stats">
        <div>
          <b>{stats.shops.toLocaleString('en-GB')}</b>
          <small>shops launched</small>
        </div>
        <div>
          <b className="amb">{usdCompactFloor(stats.fees)}</b>
          <small>waiting for owners</small>
        </div>
        <div>
          <b>0%</b>
          <small>platform cut of fees</small>
        </div>
      </div>
    </section>
  );
}
