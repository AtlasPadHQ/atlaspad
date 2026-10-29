/**
 * Search pill + suggestions dropdown (DESIGN §6.2, §16.2, §18.1). OWNED BY SEARCH.
 *
 * Desktop `[input][clear][search][sep][rocket]`; mobile `[app logo → drawer | ← back][input]
 * [clear][rocket][wallet-mini]`, and on mobile the open dropdown is a full-screen white search page.
 *
 * Dropdown (max 8 rows): Google Maps link row (paste → resolve → fly → panel) · Coins (our data:
 * ticker / coin name) · Places (Google autocomplete with a session token, or Photon) with a
 * "<b>Kebab</b> shops near <area>" category row · Recent + link tip when empty · skeleton /
 * no-results / unavailable rows · mobile "Google Maps" credit.
 * ARIA combobox (role=combobox + listbox/options, aria-activedescendant); ↑/↓/Enter/Esc.
 * Enter with nothing highlighted: link → open it; exact ticker → open the coin; else results list.
 *
 * Reads store.searchFocus (focus / prefill / link tip) and publishes store.searchOpen.
 * Contract: default export, no props.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as RClipboardEvent,
  type KeyboardEvent as RKeyboardEvent,
  type MouseEvent as RMouseEvent,
  type ReactNode,
} from 'react';
import { getDemoPlace } from '../lib/demoBridge';
import { chipFromQuery } from '../lib/categories';
import { ESC_PRIORITY, useEscapeLayer } from '../lib/escape';
import { shortAddr } from '../lib/format';
import { useIsMobile } from '../lib/media';
import { isLaunchableSource, knownIneligibility, placeFromCoin, sourceFromId } from '../lib/place';
import {
  areaName,
  autocomplete,
  cachedPlace,
  getRecentPlace,
  choosePlaceSuggestion,
  isAbortError,
  isAreaSuggestion,
  resetAutocompleteSession,
} from '../places';
import { useStore } from '../store';
import type { Coin, MatchRange, ResolvedLink } from '../types';
import { AddrBlob, AppGlyph, Change, Icon, IconButton, Sk, Sticker } from '../ui';
import { activateCategoryQuery, categoryResultCount, closeResults, currentBias, exactTickerCoin, runTextSearch } from './actions';
import { buildDropdown, type PlacesState, type Row } from './dropdownModel';
import { extractFirstUrl, linkHostLabel, looksLikeMapsLink } from './parseMapsLink';
import { openResolvedLink, resolveMapsLink } from './resolveLink';
import { useSearchUi, type PlaceChip } from './searchState';
import './search.css';

/* ================================================================== rows */

type LinkState =
  | { text: string; status: 'idle' }
  | { text: string; status: 'resolving' }
  | { text: string; status: 'resolved'; result: Exclude<ResolvedLink, { status: 'error' }> }
  | { text: string; status: 'error' };

const EMPTY_COINS: Record<string, Coin> = {};

/** "<b>Kebab</b> shops" — bold word + rest, per category (DESIGN §16.2 search.place.query). */
const QUERY_PHRASE: Record<PlaceChip, [string, string]> = {
  cafe: ['Coffee', ' shops'],
  barber: ['Barber', ' shops'],
  kebab: ['Kebab', ' shops'],
  pizza: ['Pizza', ' shops'],
  bakery: ['Bakeries', ''],
  pub: ['Pubs', ''],
  corner: ['Corner', ' shops'],
};

function Highlight({ text, ranges }: { text: string; ranges?: MatchRange[] }) {
  if (!ranges?.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  [...ranges]
    .sort((a, b) => a.start - b.start)
    .forEach((r, i) => {
      const start = Math.max(at, Math.min(text.length, r.start));
      const end = Math.max(start, Math.min(text.length, r.end));
      if (start > at) out.push(text.slice(at, start));
      if (end > start) out.push(<b key={i}>{text.slice(start, end)}</b>);
      at = end;
    });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/* ================================================================== component */

/** Recent ids whose name lookup already ran this session (a failed one isn't retried). */
const recentTried = new Set<string>();

export default function SearchBar() {
  const mobile = useIsMobile();
  const uid = useId().replace(/:/g, '');
  const listId = `sugg-${uid}`;
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const text = useSearchUi((s) => s.text);
  const setText = useSearchUi((s) => s.setText);
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(-1);
  const [tipFirst, setTipFirst] = useState(false);
  const [places, setPlaces] = useState<PlacesState>({ status: 'idle', q: '', items: [] });
  const [link, setLink] = useState<LinkState | null>(null);
  const [area, setArea] = useState<{ key: string; name: string | null } | null>(null);
  const [queryCount, setQueryCount] = useState<{ filter: PlaceChip; n: number } | null>(null);
  const [announce, setAnnounce] = useState('');
  const typedRef = useRef(false);
  const linkCtrl = useRef<AbortController | null>(null);
  const linkAct = useRef<{ text: string; launch: boolean } | null>(null);
  const pickSeq = useRef(0);

  const provider = useStore((s) => s.provider);
  const online = useStore((s) => s.online);
  const storeSearchOpen = useStore((s) => s.searchOpen);
  const setSearchOpen = useStore((s) => s.setSearchOpen);
  const focusReq = useStore((s) => s.searchFocus);
  const recent = useStore((s) => s.recent);
  const walletAddress = useStore((s) => s.wallet.address);
  const walletIcon = useStore((s) => s.wallet.icon);
  const walletKind = useStore((s) => s.wallet.kind);
  // Coins only matter while the dropdown is open (avoids re-rendering on every simulated trade).
  const coins = useStore((s) => (open ? s.coins : EMPTY_COINS));

  const q = text.trim();
  const isLink = q.length > 0 && looksLikeMapsLink(q);

  /* ---------------------------------------------------------------- open / close */

  const close = useCallback(
    (opts: { blur?: boolean } = {}) => {
      setOpen(false);
      setHl(-1);
      setTipFirst(false);
      if (opts.blur) inputRef.current?.blur();
    },
    [],
  );

  // publish to the store (App sets body.search-open; mobile hides chips/FABs underneath)
  useEffect(() => {
    setSearchOpen(open);
    if (!open) resetAutocompleteSession();
  }, [open, setSearchOpen]);
  useEffect(() => () => setSearchOpen(false), [setSearchOpen]);

  // the store closed search (openPlace / showResults set searchOpen=false)
  useEffect(() => {
    if (!storeSearchOpen && open) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeSearchOpen]);

  // click / focus outside closes (no blur race with taps on rows)
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => t instanceof Node && !!formRef.current?.contains(t);
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target)) close();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!inside(e.target)) close();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open, close]);

  useEscapeLayer(
    open,
    () => {
      close({ blur: true });
    },
    ESC_PRIORITY.dropdown,
  );

  // store.focusSearch({ text, tip }) — rocket fallback, empty states, hero "try now", QA ?search=1
  useEffect(() => {
    if (!focusReq) return;
    if (focusReq.text != null) {
      typedRef.current = false;
      setText(focusReq.text);
    }
    setTipFirst(!!focusReq.tip);
    setOpen(true);
    inputRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReq?.nonce]);

  // results list gone (closed, not just covered by a place opened from it — that keeps it in the
  // back stack) → drop the query it showed from the box and forget where it came from
  const resultsAlive = useStore((s) => s.panel === 'results' || s.panelHistory.includes('results'));
  const wasAlive = useRef(resultsAlive);
  useEffect(() => {
    const was = wasAlive.current;
    wasAlive.current = resultsAlive;
    if (!was || resultsAlive) return;
    const ui = useSearchUi.getState();
    const o = ui.origin;
    if (o && o.kind !== 'chip' && ui.text.trim() === o.query && document.activeElement !== inputRef.current) ui.setText('');
    if (o) ui.setOrigin(null);
  }, [resultsAlive]);

  /* ---------------------------------------------------------------- places suggestions */

  useEffect(() => {
    if (!open || isLink || q.length < 2 || !online) {
      setPlaces((s) => (s.status === 'idle' && s.items.length === 0 ? s : { status: 'idle', q: '', items: [] }));
      return;
    }
    const ctrl = new AbortController();
    setPlaces((s) => ({ ...s, status: 'loading', q }));
    // DESIGN §6.2: 150 ms debounce; Photon (fair-use public API) gets 250 ms.
    const t = setTimeout(
      () => {
        autocomplete(q, currentBias(), { signal: ctrl.signal })
          .then((items) => {
            if (!ctrl.signal.aborted) setPlaces({ status: 'ready', q, items });
          })
          .catch((err: unknown) => {
            if (ctrl.signal.aborted || isAbortError(err)) return;
            setPlaces({ status: 'error', q, items: [] });
          });
      },
      provider === 'google' ? 150 : 250,
    );
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [open, isLink, q, online, provider]);

  /* ---------------------------------------------------------------- link row */

  const actOnLink = useCallback(
    (result: Exclude<ResolvedLink, { status: 'error' }>, launch: boolean) => {
      close({ blur: true });
      setLink(null);
      if (result.status === 'search') {
        setText(result.query);
      } else {
        setText('');
      }
      openResolvedLink(result, {
        launch,
        onSearch: (query, near) => void runTextSearch(query, { near, origin: 'link' }),
      });
    },
    [close, setText],
  );

  const resolveLinkText = useCallback(
    (raw: string, act: { launch: boolean } | null) => {
      linkCtrl.current?.abort();
      const ctrl = new AbortController();
      linkCtrl.current = ctrl;
      linkAct.current = act ? { text: raw, launch: act.launch } : null;
      setLink({ text: raw, status: 'resolving' });
      resolveMapsLink(raw, { signal: ctrl.signal })
        .then((result) => {
          if (ctrl.signal.aborted) return;
          if (result.status === 'error') {
            linkAct.current = null;
            setLink({ text: raw, status: 'error' });
            setAnnounce("Couldn't read that link");
            return;
          }
          setLink({ text: raw, status: 'resolved', result });
          const pending = linkAct.current;
          linkAct.current = null;
          if (pending && pending.text === raw) actOnLink(result, pending.launch);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted || isAbortError(err)) return;
          linkAct.current = null;
          setLink({ text: raw, status: 'error' });
        });
    },
    [actOnLink],
  );

  useEffect(() => () => linkCtrl.current?.abort(), []);

  // typed (not pasted / prefilled) links resolve in the background so the row can show the place
  useEffect(() => {
    if (!isLink) {
      if (link) {
        linkCtrl.current?.abort();
        setLink(null);
      }
      return;
    }
    if (link?.text === q) return;
    if (!typedRef.current) {
      setLink({ text: q, status: 'idle' });
      return;
    }
    setLink({ text: q, status: 'idle' });
    const t = setTimeout(() => resolveLinkText(q, null), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLink, q]);

  const activateLink = useCallback(
    (launch: boolean) => {
      if (!link || link.text !== q) {
        resolveLinkText(q, { launch });
        return;
      }
      if (link.status === 'resolved') actOnLink(link.result, launch);
      else if (link.status === 'resolving') linkAct.current = { text: q, launch };
      else if (link.status === 'idle') resolveLinkText(q, { launch });
      // error: the row is informational only
    },
    [link, q, resolveLinkText, actOnLink],
  );

  /* ---------------------------------------------------------------- category row area name */

  const queryFilter = !isLink && q.length >= 3 ? chipFromQuery(q) : null;
  useEffect(() => {
    if (!open || !queryFilter) return;
    const v = useStore.getState().viewport;
    if (!v) return;
    const key = `${v.center.lat.toFixed(2)},${v.center.lng.toFixed(2)}`;
    if (area?.key === key) return;
    const ctrl = new AbortController();
    areaName(v.center, ctrl.signal)
      .then((name) => {
        if (!ctrl.signal.aborted) setArea({ key, name });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setArea({ key, name: null });
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, queryFilter]);

  // "· 22 places": how many shops the category row's list holds. Asked only once the query is a
  // whole category phrase (not a prefix while typing), debounced; the result is shared with the
  // list the row / chip opens (search/actions nearbyPlaces cache), so the numbers always agree.
  const exactFilter = !isLink && q.length >= 3 ? chipFromQuery(q, { exact: true }) : null;
  // the list is "near the map centre": a moved map means a different list (and count)
  const areaKey = useStore((s) => (s.viewport ? `${s.viewport.center.lat.toFixed(4)},${s.viewport.center.lng.toFixed(4)},${s.viewport.zoom}` : ''));
  useEffect(() => {
    setQueryCount(null);
    if (!open || !exactFilter || exactFilter !== queryFilter) return;
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      void categoryResultCount(exactFilter, ctrl.signal).then((n) => {
        if (!ctrl.signal.aborted) setQueryCount(n == null ? null : { filter: exactFilter, n });
      });
    }, 300);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [open, exactFilter, queryFilter, areaKey]);

  // Recent (empty input): Google places opened in an earlier session are IDs only (cs_recent), so
  // fetch their display name once per session when the list is shown; skeleton rows meanwhile.
  const [recentFetch, setRecentFetch] = useState<{ pending: ReadonlySet<string>; done: number }>({ pending: new Set(), done: 0 });
  useEffect(() => {
    if (!open || q) return;
    const st = useStore.getState();
    const missing = recent.filter((id) => !st.coins[id] && sourceFromId(id) === 'google' && !cachedPlace(id)?.name && !recentTried.has(id));
    if (missing.length === 0) return;
    missing.forEach((id) => recentTried.add(id));
    let alive = true;
    setRecentFetch((r) => ({ ...r, pending: new Set(missing) }));
    void Promise.all(missing.map((id) => getRecentPlace(id))).then(() => {
      if (alive) setRecentFetch((r) => ({ pending: new Set(), done: r.done + 1 }));
    });
    return () => {
      alive = false;
      setRecentFetch((r) => ({ ...r, pending: new Set() }));
    };
  }, [open, q, recent]);

  /* ---------------------------------------------------------------- build the dropdown */

  const { blocks, rows } = useMemo(
    () =>
      buildDropdown({
        open,
        q,
        isLink,
        tipFirst,
        recent,
        coins,
        places,
        queryFilter,
        queryCount: queryFilter && queryCount?.filter === queryFilter ? queryCount.n : null,
        online,
        mobile,
        provider,
        viewportBounds: useStore.getState().viewport?.bounds,
        recentPlace: (id) =>
          cachedPlace(id) ?? (sourceFromId(id) === 'demo' ? (getDemoPlace(id, coins) ?? undefined) : undefined),
        recentPending: (id) => recentFetch.pending.has(id),
      }),
    [open, isLink, q, tipFirst, recent, coins, places, queryFilter, queryCount, online, mobile, provider, recentFetch],
  );

  // keep the highlight valid as rows change
  useEffect(() => {
    setHl((h) => (h >= rows.length ? rows.length - 1 : h));
  }, [rows.length]);
  useEffect(() => setHl(-1), [q]);

  // polite count for screen readers once places settle
  useEffect(() => {
    if (!open || !q || isLink) return;
    if (places.status === 'ready' && places.q === q) setAnnounce(rows.length ? `${rows.length} suggestions` : `No shops match "${q}"`);
    if (places.status === 'error') setAnnounce('Search is unavailable right now');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places.status, places.q]);

  const optionId = (row: Row) => `${listId}-${row.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const activeRow = hl >= 0 ? rows[hl] : undefined;
  useEffect(() => {
    if (!activeRow) return;
    document.getElementById(optionId(activeRow))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRow?.key]);

  /* ---------------------------------------------------------------- actions */

  const finish = useCallback(() => {
    close({ blur: true });
    setText('');
    setLink(null);
  }, [close, setText]);

  const openCoin = useCallback(
    (coin: Coin) => {
      finish();
      useStore.getState().openPlace(placeFromCoin(coin), { fly: true, from: null });
    },
    [finish],
  );

  const pickPlace = useCallback(
    async (row: Extract<Row, { kind: 'place' }>, launch: boolean) => {
      const st = useStore.getState();
      if (row.coin) return openCoin(row.coin);
      if (row.place) {
        finish();
        const coin = st.coins[row.place.id];
        if (coin) st.openPlace(placeFromCoin(coin), { fly: true, from: null });
        else st.openPlace(row.place, { fly: true, from: null, launch: launch && isLaunchableSource(row.place.source) });
        return;
      }
      const s = row.s;
      const seq = ++pickSeq.current;
      const isArea = isAreaSuggestion(s);
      finish();
      const showLoading = s.source === 'google' && !isArea;
      if (showLoading) st.setPlaceLoading(null, { launchable: !st.coins[s.id] });
      const stillMine = () => seq === pickSeq.current && (!showLoading || useStore.getState().selected.status === 'loading');
      try {
        const pick = await choosePlaceSuggestion(s);
        if (!stillMine()) return;
        const now = useStore.getState();
        if (!pick) {
          if (showLoading) now.setPlaceError("Couldn't load this place.");
          else now.toast("Couldn't load this place.", 'error');
          return;
        }
        if (pick.kind === 'area') {
          if (pick.bounds) now.fitBounds(pick.bounds);
          else now.flyTo(pick.center, 15);
          return;
        }
        const coin = now.coins[pick.place.id]; // keyed on the id Google returned
        if (coin) now.openPlace(placeFromCoin(coin), { fly: true, from: null });
        else now.openPlace(pick.place, { fly: true, from: null, launch: launch && isLaunchableSource(pick.place.source) });
      } catch (err) {
        if (!stillMine() || isAbortError(err)) return;
        const now = useStore.getState();
        if (showLoading) now.setPlaceError("Couldn't load this place. Check your connection and try again.");
        else now.toast('Search is unavailable right now', 'error', undefined, 'wifi_off');
      }
    },
    [finish, openCoin],
  );

  const activate = useCallback(
    (row: Row, opts: { launch?: boolean } = {}) => {
      switch (row.kind) {
        case 'link':
          activateLink(true);
          return;
        case 'coin':
          openCoin(row.coin);
          return;
        case 'query':
          close({ blur: true });
          setText('');
          activateCategoryQuery(row.filter);
          return;
        case 'place':
          void pickPlace(row, !!opts.launch);
          return;
      }
    },
    [activateLink, openCoin, close, setText, pickPlace],
  );

  const submit = useCallback(() => {
    const query = text.trim();
    if (!query) {
      setOpen(true);
      inputRef.current?.focus();
      return;
    }
    if (looksLikeMapsLink(query)) {
      setOpen(true);
      activateLink(true);
      return;
    }
    const exact = exactTickerCoin(Object.values(useStore.getState().coins), query);
    if (exact) {
      openCoin(exact);
      return;
    }
    close({ blur: true });
    void runTextSearch(query);
  }, [text, activateLink, openCoin, close]);

  /* ---------------------------------------------------------------- input handlers */

  const onKeyDown = (e: RKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) setOpen(true);
        else if (rows.length) setHl((h) => (h + 1) % rows.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) setOpen(true);
        else if (rows.length) setHl((h) => (h <= 0 ? rows.length - 1 : h - 1));
        break;
      case 'Enter': {
        e.preventDefault();
        const row = hl >= 0 ? rows[hl] : undefined;
        if (open && row) activate(row);
        else submit();
        break;
      }
      case 'Tab':
        close();
        break;
      default:
        break;
    }
  };

  const onPaste = (e: RClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (!pasted || !looksLikeMapsLink(pasted)) return;
    e.preventDefault();
    const clean = extractFirstUrl(pasted) ?? pasted.trim();
    typedRef.current = false;
    setText(clean);
    setOpen(true);
    // paste a google maps link → fly → place panel with its Launch button (BRIEF / DESIGN §11)
    resolveLinkText(clean, { launch: false });
  };

  const clear = () => {
    linkCtrl.current?.abort();
    linkAct.current = null;
    setLink(null);
    setText('');
    if (useStore.getState().panel === 'results') closeResults({ clearText: false });
    setOpen(true);
    inputRef.current?.focus();
  };

  const onRocket = () => {
    const st = useStore.getState();
    const place = st.selected.place;
    if (st.panel === 'place' && place && st.selected.status === 'ready') {
      const coin = st.coins[place.id];
      if (coin) {
        st.toast(`This shop already has a coin — $${coin.ticker}`);
        return;
      }
      if (isLaunchableSource(place.source)) {
        if (knownIneligibility(place)) {
          st.toast("This place can't have a coin. Only open businesses can be launched.");
          return;
        }
        close();
        st.openModal({ kind: 'launch', place });
        return;
      }
    }
    setTipFirst(true);
    setOpen(true);
    inputRef.current?.focus();
  };

  const onWalletMini = () => {
    const st = useStore.getState();
    close();
    st.openModal(st.wallet.address ? { kind: 'account' } : { kind: 'wallet' });
  };

  /* ---------------------------------------------------------------- render helpers */

  const rowProps = (row: Row, index: number, className: string) => ({
    id: optionId(row),
    role: 'option' as const,
    'aria-selected': index === hl,
    className: `srow ${className}${index === hl ? ' hl' : ''}`,
    onMouseDown: (e: RMouseEvent) => e.preventDefault(),
    onMouseMove: () => {
      if (hl !== index) setHl(index);
    },
    onClick: (e: RMouseEvent) => {
      const launch = !!(e.target instanceof Element && e.target.closest('[data-act="launch"]'));
      activate(row, { launch });
    },
  });

  const renderLinkRow = (row: Row, index: number) => {
    const state = link && link.text === q ? link : { text: q, status: 'idle' as const };
    if (state.status === 'error') {
      return (
        <div key={row.key} {...rowProps(row, index, 'link two is-error')} aria-disabled="true">
          <Icon name="error" className="err" />
          <div className="tx">
            <b>Couldn&apos;t read that link</b>
            <small>Try the full google.com/maps link</small>
          </div>
        </div>
      );
    }
    let sub: ReactNode = `${linkHostLabel(q)} · tap to open this place`;
    let cta: ReactNode = (
      <span className="btn btn-primary s-cta" aria-hidden="true">
        Launch
      </span>
    );
    if (state.status === 'resolving') {
      sub = 'Finding this place…';
      cta = (
        <span className="btn btn-primary s-cta is-loading" aria-hidden="true">
          <Icon name="progress_activity" spin />
          Launch
        </span>
      );
    } else if (state.status === 'resolved') {
      const r = state.result;
      if (r.status === 'place') {
        const coin = coins[r.place.id];
        sub = [r.place.name || 'Place on Google Maps', r.place.address].filter(Boolean).join(' · ');
        cta = coin ? (
          <span className="btn btn-tonal s-cta" aria-hidden="true" translate="no">
            View ${coin.ticker}
          </span>
        ) : isLaunchableSource(r.place.source) && !knownIneligibility(r.place) ? (
          cta
        ) : (
          <span className="btn btn-tonal s-cta" aria-hidden="true">
            Open
          </span>
        );
      } else if (r.status === 'search') {
        sub = `“${r.query}” · tap to see shops`;
        cta = (
          <span className="btn btn-tonal s-cta" aria-hidden="true">
            Search
          </span>
        );
      } else {
        sub = 'A spot on the map · tap to go there';
        cta = (
          <span className="btn btn-tonal s-cta" aria-hidden="true">
            Open
          </span>
        );
      }
    }
    return (
      <div key={row.key} {...rowProps(row, index, 'link two')} aria-busy={state.status === 'resolving' || undefined}>
        <Icon name="link" />
        <div className="tx">
          <b>Google Maps link detected</b>
          <small>{sub}</small>
        </div>
        {cta}
      </div>
    );
  };

  const renderRow = (row: Row, index: number) => {
    switch (row.kind) {
      case 'link':
        return renderLinkRow(row, index);
      case 'coin': {
        const c = row.coin;
        return (
          <div key={row.key} {...rowProps(row, index, '')} aria-label={`$${c.ticker}, ${c.name}`}>
            <Sticker logo={c.logo} size={28} preferImage={false} className="av" style={{ fontSize: 16 }} />
            <div className="tx">
              <b translate="no">${c.ticker}</b> <span>· {c.name}</span>
            </div>
            <Change value={c.change24h} className="rt" />
          </div>
        );
      }
      case 'query': {
        const [word, rest] = QUERY_PHRASE[row.filter];
        const where = area?.name ? ` near ${area.name}` : ' in this area';
        return (
          <div key={row.key} {...rowProps(row, index, '')}>
            <Icon name="location_on" />
            <div className="tx">
              <b>{word}</b>
              {rest}
              {where}
              {row.count != null && row.count > 0 ? <span> · {row.count === 1 ? '1 place' : `${row.count} places`}</span> : null}
            </div>
          </div>
        );
      }
      case 'place': {
        const s = row.s;
        // parks, cities, roads, plus codes: no "Launch" on rows that can never get a coin (INTEGRATION.md §7.4)
        const launchable =
          !row.coin && (s.source === 'google' || s.source === 'demo') && !isAreaSuggestion(s) && !knownIneligibility({ source: s.source, types: s.types ?? [] });
        return (
          <div key={row.key} {...rowProps(row, index, '')}>
            <Icon name={row.place && !row.coin ? 'schedule' : 'location_on'} />
            <div className="tx">
              <Highlight text={s.main} ranges={s.matches} />
              {s.secondary ? <span> · {s.secondary}</span> : null}
            </div>
            {row.coin ? (
              <span className="rt rt-coin" translate="no">
                ${row.coin.ticker}
              </span>
            ) : launchable ? (
              <span className="rt rt-launch" data-act="launch">
                Launch
              </span>
            ) : null}
          </div>
        );
      }
    }
  };

  const renderBlocks = () => {
    let rowIndex = -1;
    return blocks.map((b) => {
      switch (b.kind) {
        case 'header':
          return (
            <div key={b.key} className="sugg-h" role="presentation">
              {b.label}
            </div>
          );
        case 'row':
          rowIndex++;
          return renderRow(b.row, rowIndex);
        case 'skeleton':
          return (
            <div key={b.key} className="srow sk-srow" aria-hidden="true">
              <Sk w={28} h={28} r="50%" />
              <Sk w="55%" h={14} />
            </div>
          );
        case 'tip':
          return (
            <div key={b.key} className="srow static" role="presentation">
              <Icon name="link" />
              <div className="tx">Paste a Google Maps link to launch any shop</div>
            </div>
          );
        case 'empty':
          return (
            <div key={b.key} className="srow two static" role="presentation">
              <Icon name="search_off" />
              <div className="tx">
                <b>No shops match &ldquo;{b.q}&rdquo;</b>
                <small>Paste a Google Maps link instead</small>
              </div>
            </div>
          );
        case 'offline':
          return (
            <div key={b.key} className="srow static" role="presentation">
              <Icon name="wifi_off" />
              <div className="tx">Search is unavailable right now</div>
            </div>
          );
        case 'credit':
          return (
            <div key={b.key} className="sugg-credit" role="presentation" translate="no">
              Google Maps
            </div>
          );
      }
    });
  };

  /* ---------------------------------------------------------------- render */

  const placeholder = mobile ? 'Search shops or paste a link' : 'Search shops or paste a Google Maps link';
  const showClear = text.length > 0;

  return (
    <form
      ref={formRef}
      role="search"
      className={`search${open ? ' open' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="search-box">
        {mobile ? (
          open ? (
            <IconButton icon="arrow_back" label="Close search" className="search-back hit" noTip onClick={() => close({ blur: true })} />
          ) : (
            <button
              type="button"
              className="search-logo hit"
              aria-label="Open menu"
              onClick={() => {
                close();
                useStore.getState().setRailOpen(true);
              }}
            >
              <AppGlyph />
            </button>
          )
        ) : null}
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Search shops or paste a Google Maps link"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-activedescendant={open && activeRow ? optionId(activeRow) : undefined}
          placeholder={placeholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
          maxLength={2048}
          value={text}
          onChange={(e) => {
            typedRef.current = true;
            setText(e.target.value);
            setTipFirst(false);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {showClear ? <IconButton icon="close" label="Clear search" className="sbtn clear hit" onClick={clear} /> : null}
        <button type="submit" className="sbtn find" aria-label="Search" data-tip="Search">
          <Icon name="search" />
        </button>
        <span className="sbtn-sep" aria-hidden="true" />
        <button type="button" className="sbtn launch hit" aria-label="Launch a coin" data-tip="Launch a coin" onClick={onRocket}>
          <Icon name="rocket_launch" fill />
        </button>
        {mobile ? (
          <button
            type="button"
            className={`wallet-mini hit${walletAddress ? ' connected' : ''}`}
            aria-label={walletAddress ? `Account ${shortAddr(walletAddress)}` : 'Connect wallet'}
            onClick={onWalletMini}
          >
            {walletAddress ? (
              walletKind === 'standard' && walletIcon ? (
                <img src={walletIcon} alt="" width={28} height={28} />
              ) : (
                <AddrBlob address={walletAddress} size={28} />
              )
            ) : (
              <Icon name="account_balance_wallet" />
            )}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="sugg" id={listId} role="listbox" aria-label="Suggestions">
          {renderBlocks()}
        </div>
      ) : (
        <div id={listId} role="listbox" aria-label="Suggestions" hidden />
      )}
      <div className="sr" aria-live="polite" role="status">
        {open ? announce : ''}
      </div>
    </form>
  );
}
