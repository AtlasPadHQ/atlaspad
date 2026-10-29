/**
 * Price change display + number tick flash. SHARED (src/ui).
 *  - <Change value={12.4} />           → `▲ 12.4%` in up/down colour (`.chg`)
 *  - <Change value={12.4} pin />       → `▲12%`
 *  - useTickFlash(value)               → 'tick-up' | 'tick-down' | '' for 600ms after a change
 *    (DESIGN §14: changed numbers flash --cs-up-bg / --cs-down-bg). Never announced to SR.
 */
import { useEffect, useRef, useState } from 'react';
import { pct, pctPin } from '../lib/format';

export function Change({ value, pin, className }: { value: number; pin?: boolean; className?: string }) {
  const up = !(value < 0);
  return <span className={['chg', up ? 'up' : 'down', className ?? ''].filter(Boolean).join(' ')}>{pin ? pctPin(value) : pct(value)}</span>;
}

export function useTickFlash(value: number): '' | 'tick-up' | 'tick-down' {
  const prev = useRef(value);
  const [cls, setCls] = useState<'' | 'tick-up' | 'tick-down'>('');
  useEffect(() => {
    if (value === prev.current) return;
    const dir = value > prev.current ? 'tick-up' : 'tick-down';
    prev.current = value;
    setCls('');
    // next frame so the animation restarts on consecutive ticks
    const raf = requestAnimationFrame(() => setCls(dir));
    const t = setTimeout(() => setCls(''), 650);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [value]);
  return cls;
}
