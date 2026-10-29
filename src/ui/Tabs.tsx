/**
 * Tabs (DESIGN §8.8): sticky `.tabs` bar, role="tablist", ←/→ move focus AND select,
 * sliding 3px indicator (200ms). Disabled tabs get aria-disabled + opacity .45 + a tooltip.
 * Panels are rendered by the caller with `id={tabPanelId(idBase, key)}` and
 * `aria-labelledby={tabId(idBase, key)}`. SHARED (src/ui).
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface TabDef<T extends string> {
  key: T;
  label: string;
  disabled?: boolean;
  /** Tooltip when disabled, e.g. "No coin yet". */
  disabledTip?: string;
}

export interface TabsProps<T extends string> {
  tabs: readonly TabDef<T>[];
  value: T;
  onChange: (key: T) => void;
  /** Unique base for ids (e.g. "place"). */
  idBase: string;
  className?: string;
  ariaLabel?: string;
}

export const tabId = (base: string, key: string) => `${base}-tab-${key}`;
export const tabPanelId = (base: string, key: string) => `${base}-panel-${key}`;

export function Tabs<T extends string>({ tabs, value, onChange, idBase, className, ariaLabel }: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const i = tabs.findIndex((t) => t.key === value);
      const btn = list.querySelectorAll<HTMLButtonElement>('[role="tab"]')[i];
      if (!btn) return;
      const w = Math.max(40, btn.offsetWidth - 48);
      setIndicator({ x: btn.offsetLeft + (btn.offsetWidth - w) / 2, w });
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(list);
    return () => ro?.disconnect();
  }, [tabs, value]);

  const enabled = tabs.filter((t) => !t.disabled);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = enabled.findIndex((t) => t.key === value);
    const n = e.key === 'ArrowLeft' ? (i - 1 + enabled.length) % enabled.length : (i + 1) % enabled.length;
    const next = enabled[n];
    if (!next) return;
    onChange(next.key);
    document.getElementById(tabId(idBase, next.key))?.focus();
  };

  return (
    <div ref={listRef} className={['tabs', className ?? ''].filter(Boolean).join(' ')} role="tablist" aria-label={ariaLabel} onKeyDown={onKey}>
      {tabs.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            id={tabId(idBase, t.key)}
            type="button"
            role="tab"
            className={['tab', active ? 'active' : '', t.disabled ? 'is-disabled' : ''].filter(Boolean).join(' ')}
            aria-selected={active}
            aria-controls={tabPanelId(idBase, t.key)}
            aria-disabled={t.disabled || undefined}
            tabIndex={active ? 0 : -1}
            data-tip={t.disabled ? t.disabledTip : undefined}
            onClick={() => {
              if (!t.disabled) onChange(t.key);
            }}
          >
            {t.label}
          </button>
        );
      })}
      {indicator ? (
        <span className="tab-ind" aria-hidden="true" style={{ transform: `translateX(${indicator.x}px)`, width: indicator.w }} />
      ) : null}
    </div>
  );
}
