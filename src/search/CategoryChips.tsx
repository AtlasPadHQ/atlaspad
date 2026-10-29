/**
 * Chips row (DESIGN §6.3, §4.3, §4.4, §18.1). OWNED BY SEARCH.
 *
 * `role="toolbar"` with a roving tabindex (←/→/Home/End), each chip `aria-pressed`. Single-select
 * coin filter via store.toggleCategory (again = off, trailing close icon while on). Category chips
 * also list nearby shops of that category (results panel + result pins); see actions.applyChip.
 * `Fees waiting` shows the unclaimed fees of the coins in view (compact USD, rounded down).
 * Desktop: one row between the search pill and the top-right chrome with a right-edge fade and a
 * `.chips-next` button (scrolls 240px; only while the row overflows and isn't at the end).
 * Tablet: second row, scrolls. Mobile: full-width scrolling row under the search pill.
 * Contract: default export, no props.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react';
import { CHIPS } from '../lib/categories';
import { prefersReducedMotion } from '../lib/media';
import { coinsInBounds, feesTotalLabel, feesWaitingTotal, useStore } from '../store';
import { Chip, Icon } from '../ui';
import { applyChip } from './actions';
import './search.css';

/**
 * Unclaimed fees of the coins inside the visible map (all coins before the map reports bounds), as the label the chip
 * shows: exact lamports summed and rounded DOWN (INTEGRATION.md §9), never to the nearest dollar. The selector returns
 * the string, so the chip re-renders only when what it shows changes.
 */
function useFeesInView(): string | null {
  return useStore((s) => {
    const list = s.viewport?.bounds ? coinsInBounds(s.coins, s.viewport.bounds) : Object.values(s.coins);
    return feesTotalLabel(feesWaitingTotal(list, s.solUsd, s.solUsdAt));
  });
}

export default function CategoryChips() {
  const category = useStore((s) => s.category);
  const fees = useFeesInView();
  const rowRef = useRef<HTMLDivElement>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const [overflow, setOverflow] = useState({ more: false, atEnd: true });

  // keep the roving tab stop on the active chip
  useEffect(() => {
    const i = CHIPS.findIndex((c) => c.filter === category);
    if (i >= 0) setFocusIdx(i);
  }, [category]);

  const measure = useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    const more = el.scrollWidth > el.clientWidth + 1;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    setOverflow((o) => (o.more === more && o.atEnd === atEnd ? o : { more, atEnd }));
  }, []);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    measure();
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null;
    ro?.observe(el);
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      window.removeEventListener('resize', onScroll);
    };
  }, [measure]);

  // the fees label changes the row width
  useEffect(() => {
    measure();
  }, [fees, category, measure]);

  const focusChip = (i: number) => {
    const n = CHIPS.length;
    const idx = ((i % n) + n) % n;
    setFocusIdx(idx);
    const btn = rowRef.current?.querySelectorAll<HTMLButtonElement>('button.chip')[idx];
    btn?.focus();
    btn?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  const onKeyDown = (e: RKeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        focusChip(focusIdx + 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        focusChip(focusIdx - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusChip(0);
        break;
      case 'End':
        e.preventDefault();
        focusChip(CHIPS.length - 1);
        break;
      default:
        break;
    }
  };

  const scrollNext = () => {
    rowRef.current?.scrollBy({ left: 240, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  return (
    <>
      <div
        ref={rowRef}
        className={`chips${overflow.atEnd ? ' at-end' : ''}`}
        role="toolbar"
        aria-label="Filters"
        onKeyDown={onKeyDown}
      >
        {CHIPS.map((c, i) => {
          const on = category === c.filter;
          const isFees = c.filter === 'fees';
          return (
            <Chip
              key={c.filter}
              emoji={c.emoji}
              icon={c.icon}
              on={on}
              className={`hit${isFees ? ' fees' : ''}`}
              tabIndex={i === focusIdx ? 0 : -1}
              onFocus={() => setFocusIdx(i)}
              onClick={() => applyChip(c.filter)}
              aria-label={isFees && fees ? `Fees waiting, ${fees} in view` : undefined}
            >
              {c.label}
              {isFees && fees ? (
                <span className="n num" aria-hidden="true">
                  {fees}
                </span>
              ) : null}
            </Chip>
          );
        })}
        <span className="chips-end" aria-hidden="true" />
      </div>
      <button
        type="button"
        className="chips-next"
        aria-label="More filters"
        data-tip="More filters"
        tabIndex={-1}
        hidden={!overflow.more || overflow.atEnd}
        onClick={scrollNext}
      >
        <Icon name="chevron_right" size={20} />
      </button>
    </>
  );
}
