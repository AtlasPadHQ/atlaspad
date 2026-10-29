/**
 * Segmented control (`.seg`, DESIGN §8.10): role="radiogroup", ←/→ move + select.
 * Used by the chart range, Live/Top shops sort, launch "First buy". SHARED (src/ui).
 */
import { useRef, type KeyboardEvent } from 'react';

export interface SegOption<T extends string> {
  value: T;
  label: string;
  /** Accessible name when the visible label is terse (e.g. "0.5" → "0.5 SOL"). */
  ariaLabel?: string;
}

export interface SegProps<T extends string> {
  options: readonly SegOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}

export function Seg<T extends string>({ options, value, onChange, ariaLabel, className, disabled }: SegProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    let n = i;
    if (e.key === 'ArrowLeft') n = (i - 1 + options.length) % options.length;
    if (e.key === 'ArrowRight') n = (i + 1) % options.length;
    if (e.key === 'Home') n = 0;
    if (e.key === 'End') n = options.length - 1;
    const next = options[n];
    if (!next) return;
    onChange(next.value);
    ref.current?.querySelectorAll<HTMLButtonElement>('button')[n]?.focus();
  };
  return (
    <div ref={ref} className={['seg', className ?? ''].filter(Boolean).join(' ')} role="radiogroup" aria-label={ariaLabel} onKeyDown={onKey}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.ariaLabel}
            tabIndex={on ? 0 : -1}
            className={['hit', on ? 'on' : ''].filter(Boolean).join(' ')}
            disabled={disabled}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
