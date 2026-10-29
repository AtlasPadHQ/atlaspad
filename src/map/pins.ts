/**
 * Coin pins, the selected balloon, search-result pins and the user-location dot as plain DOM
 * (DESIGN §7). Provider-agnostic: an adapter hands over three root elements
 *   - `under` (user dot; Google `overlayLayer`, non-interactive),
 *   - `pins`  (coin + result pins; Google `overlayMouseTarget`),
 *   - `float` (the selected pin; Google `floatPane`),
 * and calls `layout(project, w, h, zoom)` whenever the camera or container changes.
 *
 * Performance (40–500 pins): pins are created once and diffed; DOM writes happen only when a
 * rendered value changes; pins outside the container (+ margin) are culled with `hidden`;
 * declutter is debounced and runs only at label zooms; flashes are skipped while the tab is
 * hidden; every timer is tracked and cleared in `destroy()`.
 *
 * Google ToS: pins show only our data (ticker, launcher-typed coin name in the aria-label,
 * market data, launcher-picked emoji). Search-result pins show the category emoji only.
 */
import { LOW_ZOOM } from '../config';
import { pctPin, pctSpoken, usdCompact } from '../lib/format';
import { prefersReducedMotion } from '../lib/media';
import { isLaunchableSource, knownIneligibility } from '../lib/place';
import { feesWaiting } from '../store';
import type { Coin, LatLng, LayersState, Place, SelectedPin, TradeSide, UserLocation } from '../types';
import { BALLOON_HTML } from '../ui/Icons';
import { declutterLabels, selectedRects, type DeclutterItem, type LabelSide } from './declutter';
import { clamp, isUsableLocation, safeBg } from './util';

/* ------------------------------------------------------------------ constants */

/** Fee dot threshold (DESIGN §7.2: unclaimed and fees ≥ $500). */
const FEE_DOT_MIN_USD = 500;
/** Buy/sell flash: 2 cycles of 1.4s, then removed (reduced motion: static tag for 3s). */
const FLASH_MS = 2800;
const FLASH_MS_REDUCED = 3000;
/** New-launch pop (§14): 450ms. */
const POP_MS = 450;
/** Coins launched this recently pop in when first seen. */
const NEW_LAUNCH_WINDOW_MS = 30_000;
/** Cull margin around the container (labels extend right of the anchor, so more on the left). */
const CULL = { left: 160, top: 64, right: 64, bottom: 64 } as const;
const DECLUTTER_MS = 150;
/** User-location halo diameter bounds (§7.3). */
const HALO_MIN = 72;
const HALO_MAX = 240;
/** Pointer travel (px²) above which a click on a pin counts as the end of a map drag. */
const DRAG_SLOP_SQ = 36;

const FONT = '"Roboto Flex", Roboto, "Helvetica Neue", Arial, sans-serif';
const F_TICKER = `700 13.5px ${FONT}`;
const F_META = `600 11px ${FONT}`;
const F_TICKER_SEL = `700 15px ${FONT}`;
const F_META_SEL = `600 12px ${FONT}`;

/* ------------------------------------------------------------------ label metrics */

let measureCtx: CanvasRenderingContext2D | null | undefined;
const widthCache = new Map<string, number>();

function textWidth(text: string, font: string): number {
  const key = `${font}|${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement('canvas').getContext('2d');
    } catch {
      measureCtx = null;
    }
  }
  let w: number;
  if (measureCtx) {
    measureCtx.font = font;
    w = measureCtx.measureText(text).width;
  } else {
    // Fallback estimate: ~0.6em per character.
    w = text.length * Number.parseFloat(font.split(' ')[1] ?? '12') * 0.6;
  }
  if (widthCache.size > 4000) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

function labelWidth(b: string, small: string, selected: boolean): number {
  const wb = textWidth(b, selected ? F_TICKER_SEL : F_TICKER) + 0.1 * b.length;
  const ws = textWidth(small, selected ? F_META_SEL : F_META);
  // + white text halo (1.5px each side)
  return Math.ceil(Math.max(wb, ws)) + 3;
}

/* ------------------------------------------------------------------ DOM helpers */

function span(cls?: string): HTMLSpanElement {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  return s;
}

function pinButton(cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.hidden = true; // shown once positioned
  return b;
}

function hiddenFromAT<T extends HTMLElement>(el: T): T {
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/* ------------------------------------------------------------------ types */

export interface PinRoots {
  under: HTMLElement;
  pins: HTMLElement;
  float: HTMLElement;
}

export interface PinEvents {
  coin(placeId: string): void;
  result(placeId: string): void;
  selected(fromKeyboard: boolean): void;
}

/** Projects a lat/lng to container px (`cx/cy`, for culling/declutter) and root px (`px/py`, for placement). */
export type Projector = (ll: LatLng) => { cx: number; cy: number; px: number; py: number } | null;

interface Positioned {
  el: HTMLElement;
  loc: LatLng;
  x: number;
  y: number;
  tx: number;
  ty: number;
  shown: boolean;
  tabbable: boolean;
  suppressed: boolean;
}

interface CoinTexts {
  emoji: string;
  bg: string;
  b: string;
  pct: string;
  up: boolean;
  meta: string;
  fees: boolean;
  verified: boolean;
  aria: string;
}

interface CoinPin extends Positioned {
  id: string;
  coin: Coin;
  el: HTMLButtonElement;
  mk: HTMLSpanElement;
  b: HTMLElement;
  chg: HTMLSpanElement;
  meta: Text;
  lb: HTMLSpanElement;
  feeDot: HTMLSpanElement | null;
  vtick: HTMLSpanElement | null;
  tag: HTMLSpanElement | null;
  t: CoinTexts;
  labelW: number;
  side: LabelSide;
  z: number;
  flashTimer: number;
  popTimer: number;
}

interface ResultPin extends Positioned {
  id: string;
  mk: HTMLSpanElement;
  emoji: string;
  aria: string;
}

type SelKind = 'coin' | 'launchable' | 'other';

interface SelPin extends Positioned {
  id: string;
  kind: SelKind;
  face: HTMLSpanElement;
  b: HTMLElement;
  small: HTMLElement;
  bText: string;
  smallText: string;
  aria: string;
  bg: string;
  emoji: string;
  labelW: number;
}

interface MePin extends Positioned {
  accuracy: number;
  halo: number;
}

function coinTexts(coin: Coin): CoinTexts {
  const mc = usdCompact(coin.marketCapUsd);
  const fees = !coin.claimed && feesWaiting(coin) >= FEE_DOT_MIN_USD;
  const verified = coin.claimed && coin.ownerVerified;
  return {
    emoji: coin.logo.emoji || '🏪',
    bg: safeBg(coin.logo.bg),
    b: `$${coin.ticker}`,
    pct: pctPin(coin.change24h),
    up: !(coin.change24h < 0),
    meta: ` · ${mc}`,
    fees,
    verified,
    aria: `$${coin.ticker}, ${coin.name}, ${pctSpoken(coin.change24h)}, market cap ${mc}${fees ? ', fees waiting' : ''}${verified ? ', owner verified' : ''}`,
  };
}

/* ------------------------------------------------------------------ layer */

export class PinLayer {
  private readonly coins = new Map<string, CoinPin>();
  private order: CoinPin[] = [];
  private orderDirty = false;
  private readonly known = new Set<string>();
  private readonly results = new Map<string, ResultPin>();
  private sel: SelPin | null = null;
  private me: MePin | null = null;
  private layers: LayersState | null = null;
  private project: Projector | null = null;
  private view = { w: 0, h: 0, zoom: 0 };
  private declutterTimer = 0;
  private initialized = false;
  private destroyed = false;
  private down: { x: number; y: number } | null = null;
  private readonly coinLayer: HTMLDivElement;
  private readonly resLayer: HTMLDivElement;

  constructor(
    private readonly roots: PinRoots,
    private readonly events: PinEvents,
  ) {
    roots.under.classList.add('cs-root', 'cs-under');
    roots.pins.classList.add('cs-root', 'cs-pins');
    roots.float.classList.add('cs-root', 'cs-pins', 'cs-float');
    this.coinLayer = document.createElement('div');
    this.coinLayer.className = 'cs-root cs-coins';
    this.resLayer = document.createElement('div');
    this.resLayer.className = 'cs-root cs-results';
    roots.pins.append(this.coinLayer, this.resLayer);
    for (const r of [roots.pins, roots.float]) {
      r.addEventListener('pointerdown', this.onPointerDown);
      r.addEventListener('click', this.onClick);
      r.addEventListener('dblclick', this.onDblClick);
    }
    // Re-measure labels once Roboto Flex has loaded (metrics change).
    try {
      void document.fonts?.ready.then(() => {
        if (this.destroyed) return;
        widthCache.clear();
        for (const p of this.coins.values()) p.labelW = labelWidth(p.t.b, p.t.pct + p.t.meta, false);
        if (this.sel) this.sel.labelW = labelWidth(this.sel.bText, this.sel.smallText, true);
        this.scheduleDeclutter();
      });
    } catch {
      /* document.fonts unsupported: estimates stay */
    }
  }

  /* -------------------------------------------------------------- events */

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  /** Double-clicking a pin must not also zoom the map. */
  private readonly onDblClick = (e: MouseEvent): void => {
    if (e.target instanceof Element && e.target.closest('button.pin')) e.stopPropagation();
  };

  private readonly onClick = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    const btn = target?.closest<HTMLButtonElement>('button.pin');
    if (!btn) return;
    // Pins never also produce a map / POI click.
    e.stopPropagation();
    const keyboard = e.detail === 0;
    const down = this.down;
    this.down = null;
    if (!keyboard && down) {
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (dx * dx + dy * dy > DRAG_SLOP_SQ) return; // end of a map drag that started on a pin
    }
    const id = btn.dataset.id ?? '';
    switch (btn.dataset.kind) {
      case 'coin':
        this.events.coin(id);
        if (keyboard) this.focusPanelSoon();
        break;
      case 'res':
        this.events.result(id);
        if (keyboard) this.focusPanelSoon();
        break;
      case 'sel':
        this.events.selected(keyboard);
        break;
      default:
        break;
    }
  };

  /**
   * Keyboard activation (Enter/Space) of a pin: once selected, the pin is hidden (the balloon in
   * the float pane replaces it), which would drop focus to <body>. Move focus into the panel the
   * pin opened instead (same target as "Skip to panel"), unless focus already went somewhere else.
   */
  private focusPanelSoon(): void {
    let tries = 0;
    const go = () => {
      if (this.destroyed) return;
      const a = document.activeElement;
      const lost = !a || a === document.body || this.roots.pins.contains(a) || this.roots.float.contains(a);
      if (!lost) return;
      const el = document.querySelector<HTMLElement>('.panel .panel-scroll');
      if (el && el.childElementCount > 0) {
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
        el.focus({ preventScroll: true });
        return;
      }
      if (++tries < 20) window.setTimeout(go, 50);
    };
    window.setTimeout(go, 0);
  }

  /* -------------------------------------------------------------- coins */

  setCoins(list: readonly Coin[]): void {
    if (this.destroyed) return;
    const now = Date.now();
    const seen = new Set<string>();
    for (const coin of list) {
      if (!isUsableLocation(coin.place.location)) continue;
      seen.add(coin.placeId);
      const existing = this.coins.get(coin.placeId);
      if (!existing) {
        const p = this.createCoinPin(coin);
        this.coins.set(coin.placeId, p);
        this.coinLayer.append(p.el);
        if (this.initialized && !this.known.has(coin.placeId) && now - coin.launchedAt < NEW_LAUNCH_WINDOW_MS) this.pop(p);
        this.known.add(coin.placeId);
        this.orderDirty = true;
        this.placeOne(p);
      } else if (existing.coin !== coin) {
        this.updateCoinPin(existing, coin);
      }
    }
    for (const [id, p] of this.coins) if (!seen.has(id)) this.removeCoinPin(p);
    if (!this.initialized) for (const id of seen) this.known.add(id);
    this.initialized = true;

    const next = [...this.coins.values()].sort(
      (a, b) => b.coin.marketCapUsd - a.coin.marketCapUsd || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    if (next.length !== this.order.length || next.some((p, i) => p !== this.order[i])) {
      this.order = next;
      this.orderDirty = true;
      const n = next.length;
      next.forEach((p, i) => {
        const z = n - i;
        if (p.z !== z) {
          p.z = z;
          p.el.style.zIndex = String(z);
        }
      });
    }
    this.syncSuppression();
    this.scheduleDeclutter();
  }

  private createCoinPin(coin: Coin): CoinPin {
    const el = pinButton('pin');
    el.dataset.kind = 'coin';
    el.dataset.id = coin.placeId;
    const hit = hiddenFromAT(span('pin-hit'));
    const mk = hiddenFromAT(span('mk'));
    const lb = hiddenFromAT(span('lb'));
    const b = document.createElement('b');
    b.setAttribute('translate', 'no');
    const small = document.createElement('small');
    const chg = span();
    const meta = document.createTextNode('');
    small.append(chg, meta);
    lb.append(b, small);
    el.append(hit, mk, lb);
    const p: CoinPin = {
      id: coin.placeId,
      coin,
      el,
      mk,
      b,
      chg,
      meta,
      lb,
      feeDot: null,
      vtick: null,
      tag: null,
      t: { emoji: '', bg: '', b: '', pct: '', up: true, meta: '', fees: false, verified: false, aria: '' },
      labelW: 0,
      side: 'right',
      z: 0,
      flashTimer: 0,
      popTimer: 0,
      loc: coin.place.location,
      x: Number.NaN,
      y: Number.NaN,
      tx: Number.NaN,
      ty: Number.NaN,
      shown: false,
      tabbable: true,
      suppressed: false,
    };
    this.updateCoinPin(p, coin);
    return p;
  }

  private updateCoinPin(p: CoinPin, coin: Coin): void {
    p.coin = coin;
    if (p.loc.lat !== coin.place.location.lat || p.loc.lng !== coin.place.location.lng) {
      p.loc = coin.place.location;
      this.placeOne(p);
    }
    const t = coinTexts(coin);
    const o = p.t;
    if (t.emoji !== o.emoji) p.mk.textContent = t.emoji;
    if (t.bg !== o.bg) p.el.style.setProperty('--bg', t.bg);
    if (t.b !== o.b) p.b.textContent = t.b;
    if (t.pct !== o.pct) p.chg.textContent = t.pct;
    if (t.up !== o.up || !o.pct) p.chg.className = t.up ? 'up' : 'down';
    if (t.meta !== o.meta) p.meta.data = t.meta;
    if (t.aria !== o.aria) p.el.setAttribute('aria-label', t.aria);
    if (t.fees !== o.fees || !o.aria) {
      if (t.fees && !p.feeDot) {
        p.feeDot = hiddenFromAT(span('fee-dot'));
        p.feeDot.title = 'Fees waiting';
        p.mk.after(p.feeDot);
      } else if (!t.fees && p.feeDot) {
        p.feeDot.remove();
        p.feeDot = null;
      }
    }
    if (t.verified !== o.verified || !o.aria) {
      if (t.verified && !p.vtick) {
        p.vtick = hiddenFromAT(span('vtick'));
        const ic = span('ms');
        ic.textContent = 'check';
        p.vtick.append(ic);
        p.mk.after(p.vtick);
      } else if (!t.verified && p.vtick) {
        p.vtick.remove();
        p.vtick = null;
      }
    }
    if (t.b !== o.b || t.pct !== o.pct || t.meta !== o.meta) p.labelW = labelWidth(t.b, t.pct + t.meta, false);
    p.t = t;
  }

  private removeCoinPin(p: CoinPin): void {
    window.clearTimeout(p.flashTimer);
    window.clearTimeout(p.popTimer);
    p.el.remove();
    this.coins.delete(p.id);
    this.orderDirty = true;
  }

  private pop(p: CoinPin): void {
    if (prefersReducedMotion()) return;
    p.el.classList.add('pop');
    p.popTimer = window.setTimeout(() => {
      p.popTimer = 0;
      p.el.classList.remove('pop');
    }, POP_MS + 50);
  }

  /* -------------------------------------------------------------- flashes */

  /** Buy/sell flash (DESIGN §7.2): ring ×2 cycles + tag, then removed; a new trade restarts it. */
  flash(placeId: string, side: TradeSide, label: string): void {
    if (this.destroyed) return;
    if (this.layers && !this.layers.flashes) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const p = this.coins.get(placeId);
    if (!p || !p.shown || p.suppressed) return;
    const restarting = p.el.classList.contains('flash');
    p.el.classList.remove('flash', 'buy', 'sell');
    if (!p.tag) {
      p.tag = hiddenFromAT(span('tag'));
      p.el.append(p.tag);
    }
    p.tag.textContent = label;
    if (restarting) void p.el.offsetWidth; // restart the CSS animation
    p.el.classList.add('flash', side);
    window.clearTimeout(p.flashTimer);
    p.flashTimer = window.setTimeout(() => this.endFlash(p), prefersReducedMotion() ? FLASH_MS_REDUCED : FLASH_MS);
  }

  private endFlash(p: CoinPin): void {
    p.flashTimer = 0;
    p.el.classList.remove('flash', 'buy', 'sell');
    p.tag?.remove();
    p.tag = null;
  }

  clearFlashes(): void {
    for (const p of this.coins.values()) {
      if (p.flashTimer) {
        window.clearTimeout(p.flashTimer);
        this.endFlash(p);
      }
    }
  }

  /* -------------------------------------------------------------- layers */

  setLayers(l: LayersState): void {
    this.layers = l;
    for (const r of [this.roots.pins, this.roots.float]) {
      r.classList.toggle('no-fees', !l.feeDots);
      r.classList.toggle('no-ticks', !l.ticks);
    }
    if (!l.flashes) this.clearFlashes();
  }

  /* -------------------------------------------------------------- selection */

  setSelected(s: SelectedPin | null): void {
    if (this.destroyed) return;
    const place = s?.place;
    if (!s || !place || !isUsableLocation(place.location)) {
      this.removeSel();
      return;
    }
    // non-business places (parks, cities, roads, closed shops) never read "Launch here" (INTEGRATION.md §7.4)
    const kind: SelKind = s.coin ? 'coin' : isLaunchableSource(place.source) && !knownIneligibility(place) ? 'launchable' : 'other';
    const loc = s.coin ? s.coin.place.location : place.location;
    if (this.sel && this.sel.id === place.id && this.sel.kind === kind) {
      this.updateSel(this.sel, s, kind);
      if (this.sel.loc.lat !== loc.lat || this.sel.loc.lng !== loc.lng) {
        this.sel.loc = loc;
        this.placeOne(this.sel);
      }
      return;
    }
    this.removeSel();
    const el = pinButton(`pin sel${kind !== 'coin' ? ' launchable' : ''}${kind === 'other' ? ' other' : ''}`);
    el.dataset.kind = 'sel';
    el.dataset.id = place.id;
    const balloon = hiddenFromAT(span('balloon'));
    balloon.innerHTML = kind === 'coin' ? BALLOON_HTML.coin : BALLOON_HTML.launchable; // static, trusted markup
    const face = span('face');
    balloon.append(face);
    const lb = hiddenFromAT(span('lb'));
    const b = document.createElement('b');
    const small = document.createElement('small');
    lb.append(b, small);
    el.append(balloon, lb);
    const sel: SelPin = {
      id: place.id,
      kind,
      el,
      face,
      b,
      small,
      bText: '',
      smallText: '',
      aria: '',
      bg: '',
      emoji: '',
      labelW: 0,
      loc,
      x: Number.NaN,
      y: Number.NaN,
      tx: Number.NaN,
      ty: Number.NaN,
      shown: false,
      tabbable: true,
      suppressed: false,
    };
    if (kind !== 'coin') {
      const ic = span('ms fill');
      ic.textContent = kind === 'launchable' ? 'rocket_launch' : 'storefront';
      face.append(ic);
    } else {
      b.setAttribute('translate', 'no');
    }
    this.updateSel(sel, s, kind);
    this.sel = sel;
    this.roots.float.append(el);
    this.placeOne(sel);
    this.syncSuppression();
    this.scheduleDeclutter();
  }

  private updateSel(sel: SelPin, s: SelectedPin, kind: SelKind): void {
    let bText: string;
    let smallText: string;
    let aria: string;
    if (kind === 'coin' && s.coin) {
      const t = coinTexts(s.coin);
      bText = t.b;
      smallText = t.pct + t.meta;
      aria = `${t.aria}, selected`;
      if (t.bg !== sel.bg) {
        sel.bg = t.bg;
        sel.el.style.setProperty('--bg', t.bg);
      }
      if (t.emoji !== sel.emoji) {
        sel.emoji = t.emoji;
        sel.face.textContent = t.emoji;
      }
      // small = <span class="up">▲12%</span> · $212k
      if (smallText !== sel.smallText) {
        sel.small.textContent = '';
        const chg = span(t.up ? 'up' : 'down');
        chg.textContent = t.pct;
        sel.small.append(chg, document.createTextNode(t.meta));
      }
    } else {
      const never = kind === 'other' && isLaunchableSource(s.place.source) && !!knownIneligibility(s.place);
      bText = kind === 'launchable' ? 'Launch here' : s.place.name || 'Selected place';
      smallText = never ? "Can't have a coin" : 'No coin yet';
      aria = kind === 'launchable' ? 'Launch a coin here' : `${s.place.name || 'Selected place'}, ${never ? "can't have a coin" : 'no coin yet'}`;
      if (smallText !== sel.smallText) sel.small.textContent = smallText;
    }
    if (bText !== sel.bText) sel.b.textContent = bText;
    if (aria !== sel.aria) sel.el.setAttribute('aria-label', aria);
    if (bText !== sel.bText || smallText !== sel.smallText) sel.labelW = labelWidth(bText, smallText, true);
    sel.bText = bText;
    sel.smallText = smallText;
    sel.aria = aria;
  }

  private removeSel(): void {
    if (!this.sel) return;
    this.sel.el.remove();
    this.sel = null;
    this.syncSuppression();
    this.scheduleDeclutter();
  }

  /** The selected place's own coin pin / result pin is hidden while its balloon shows. */
  private syncSuppression(): void {
    const selId = this.sel?.id ?? null;
    for (const p of this.coins.values()) {
      const s = p.id === selId;
      if (s !== p.suppressed) {
        p.suppressed = s;
        if (s && p.flashTimer) {
          window.clearTimeout(p.flashTimer);
          this.endFlash(p);
        }
        this.placeOne(p);
      }
    }
    for (const r of this.results.values()) {
      const s = r.id === selId || this.coins.has(r.id);
      if (s !== r.suppressed) {
        r.suppressed = s;
        this.placeOne(r);
      }
    }
  }

  /* -------------------------------------------------------------- results */

  setResults(places: readonly Place[]): void {
    if (this.destroyed) return;
    const seen = new Set<string>();
    places.forEach((pl, i) => {
      if (!isUsableLocation(pl.location) || seen.has(pl.id)) return;
      seen.add(pl.id);
      const aria = `Search result ${i + 1}: ${pl.name || pl.categoryLabel}`;
      const emoji = pl.emoji || '🏪';
      let r = this.results.get(pl.id);
      if (!r) {
        const el = pinButton('pin res');
        el.dataset.kind = 'res';
        el.dataset.id = pl.id;
        const mk = hiddenFromAT(span('mk'));
        el.append(hiddenFromAT(span('pin-hit')), mk);
        r = {
          id: pl.id,
          el,
          mk,
          emoji: '',
          aria: '',
          loc: pl.location,
          x: Number.NaN,
          y: Number.NaN,
          tx: Number.NaN,
          ty: Number.NaN,
          shown: false,
          tabbable: true,
          suppressed: false,
        };
        this.results.set(pl.id, r);
        this.resLayer.append(el);
      }
      if (r.emoji !== emoji) {
        r.emoji = emoji;
        r.mk.textContent = emoji;
      }
      if (r.aria !== aria) {
        r.aria = aria;
        r.el.setAttribute('aria-label', aria);
      }
      r.loc = pl.location;
      this.placeOne(r);
    });
    for (const [id, r] of this.results) {
      if (!seen.has(id)) {
        r.el.remove();
        this.results.delete(id);
      }
    }
    this.syncSuppression();
  }

  /* -------------------------------------------------------------- user location */

  setUser(loc: UserLocation | null): void {
    if (this.destroyed) return;
    if (!loc || !isUsableLocation(loc.location)) {
      this.me?.el.remove();
      this.me = null;
      return;
    }
    if (!this.me) {
      const el = hiddenFromAT(document.createElement('div'));
      el.className = 'me';
      el.hidden = true;
      el.append(document.createElement('i'));
      this.roots.under.append(el);
      this.me = {
        el,
        loc: loc.location,
        accuracy: loc.accuracy,
        halo: 0,
        x: Number.NaN,
        y: Number.NaN,
        tx: Number.NaN,
        ty: Number.NaN,
        shown: false,
        tabbable: false,
        suppressed: false,
      };
    }
    this.me.loc = loc.location;
    this.me.accuracy = Number.isFinite(loc.accuracy) ? Math.max(0, loc.accuracy) : 0;
    this.placeMe(this.me);
  }

  /* -------------------------------------------------------------- layout */

  /** Position everything for the current camera. Cheap: only changed values touch the DOM. */
  layout(project: Projector, width: number, height: number, zoom: number): void {
    if (this.destroyed) return;
    this.project = project;
    this.view = { w: width, h: height, zoom };
    for (const p of this.coins.values()) this.placeOne(p);
    for (const r of this.results.values()) this.placeOne(r);
    if (this.sel) this.placeOne(this.sel);
    if (this.me) this.placeMe(this.me);
  }

  private placeOne(item: Positioned): void {
    const pr = this.project ? this.project(item.loc) : null;
    const { w, h } = this.view;
    if (pr) {
      item.x = pr.cx;
      item.y = pr.cy;
    }
    const vis =
      !!pr &&
      !item.suppressed &&
      w > 0 &&
      h > 0 &&
      pr.cx >= -CULL.left &&
      pr.cx <= w + CULL.right &&
      pr.cy >= -CULL.top &&
      pr.cy <= h + CULL.bottom;
    if (vis !== item.shown) {
      item.el.hidden = !vis;
      item.shown = vis;
    }
    if (!vis || !pr) return;
    const tx = Math.round(pr.px);
    const ty = Math.round(pr.py);
    if (tx !== item.tx || ty !== item.ty) {
      item.el.style.transform = `translate(${tx}px,${ty}px)`;
      item.tx = tx;
      item.ty = ty;
    }
    // Pins in the cull margin stay rendered but out of the Tab order (focusing them would scroll the map).
    const inView = pr.cx >= 0 && pr.cx <= w && pr.cy >= 0 && pr.cy <= h;
    if (inView !== item.tabbable && item.el instanceof HTMLButtonElement) {
      item.el.tabIndex = inView ? 0 : -1;
      item.tabbable = inView;
    }
  }

  private placeMe(me: MePin): void {
    this.placeOne(me);
    if (!me.shown || !this.project) return;
    // Halo diameter from the reported accuracy (§7.3, min 72 / max 240 px).
    const north = this.project({ lat: Math.min(89.9, me.loc.lat + me.accuracy / 111_320), lng: me.loc.lng });
    const r = north ? Math.abs(me.y - north.cy) : 0;
    const halo = Math.round(clamp(2 * r, HALO_MIN, HALO_MAX));
    if (halo !== me.halo) {
      me.halo = halo;
      me.el.style.setProperty('--halo', `${halo}px`);
    }
  }

  /* -------------------------------------------------------------- declutter */

  scheduleDeclutter(): void {
    if (this.destroyed) return;
    window.clearTimeout(this.declutterTimer);
    this.declutterTimer = window.setTimeout(() => this.declutter(), DECLUTTER_MS);
  }

  /** Run declutter now (on idle / moveend). */
  declutter(): void {
    window.clearTimeout(this.declutterTimer);
    this.declutterTimer = 0;
    if (this.destroyed) return;
    if (this.orderDirty) this.reorderDom();
    const { w, h, zoom } = this.view;
    if (!w || !h || zoom < LOW_ZOOM) return; // labels are hidden below LOW_ZOOM (body.lowzoom)
    const reserved = this.sel?.shown ? selectedRects(this.sel.x, this.sel.y, this.sel.labelW) : [];
    const items: DeclutterItem[] = [];
    for (const p of this.order) if (p.shown && !p.suppressed) items.push({ id: p.id, x: p.x, y: p.y, labelW: p.labelW });
    const sides = declutterLabels(items, { width: w, height: h, reserved });
    for (const p of this.order) {
      const side = sides.get(p.id);
      if (!side || side === p.side) continue;
      p.side = side;
      p.el.classList.toggle('left', side === 'left');
      p.el.classList.toggle('nolabel', side === 'hidden');
    }
  }

  /** Tab order = market cap, descending (DOM order). Skipped while a pin has focus. */
  private reorderDom(): void {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active && this.coinLayer.contains(active)) return;
    this.orderDirty = false;
    const kids = this.coinLayer.children;
    let inOrder = kids.length === this.order.length;
    if (inOrder) {
      for (let i = 0; i < this.order.length; i++) {
        if (kids[i] !== this.order[i]?.el) {
          inOrder = false;
          break;
        }
      }
    }
    if (inOrder) return;
    const frag = document.createDocumentFragment();
    for (const p of this.order) frag.append(p.el);
    this.coinLayer.append(frag);
  }

  /* -------------------------------------------------------------- teardown */

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.clearTimeout(this.declutterTimer);
    for (const p of this.coins.values()) {
      window.clearTimeout(p.flashTimer);
      window.clearTimeout(p.popTimer);
    }
    for (const r of [this.roots.pins, this.roots.float]) {
      r.removeEventListener('pointerdown', this.onPointerDown);
      r.removeEventListener('click', this.onClick);
      r.removeEventListener('dblclick', this.onDblClick);
    }
    this.coins.clear();
    this.results.clear();
    this.order = [];
    this.sel = null;
    this.me = null;
    this.project = null;
    this.roots.under.replaceChildren();
    this.roots.pins.replaceChildren();
    this.roots.float.replaceChildren();
    this.roots.under.remove();
    this.roots.pins.remove();
    this.roots.float.remove();
  }
}
