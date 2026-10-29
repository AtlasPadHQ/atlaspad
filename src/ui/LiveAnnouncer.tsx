/**
 * Screen-reader summary of live activity (DESIGN §15): the feed itself is not a live region;
 * this visually hidden polite region announces at most once every 10s, e.g. "3 new trades".
 * Price ticks are never announced. Mounted once by App. SHARED (src/ui).
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';

export function LiveAnnouncer() {
  const [text, setText] = useState('');
  const pending = useRef({ trades: 0, launches: 0, claims: 0 });

  useEffect(() => {
    const unsub = useStore.subscribe(
      (s) => s.feed[0]?.id,
      (_id, _prev) => {
        const ev = useStore.getState().feed[0];
        if (!ev) return;
        if (ev.kind === 'trade') pending.current.trades++;
        else if (ev.kind === 'launch') pending.current.launches++;
        else if (ev.kind === 'claim') pending.current.claims++;
      },
    );
    const iv = setInterval(() => {
      const p = pending.current;
      const parts: string[] = [];
      if (p.launches) parts.push(`${p.launches} new ${p.launches === 1 ? 'launch' : 'launches'}`);
      if (p.trades) parts.push(`${p.trades} new ${p.trades === 1 ? 'trade' : 'trades'}`);
      if (p.claims) parts.push(`${p.claims} new ${p.claims === 1 ? 'claim' : 'claims'}`);
      pending.current = { trades: 0, launches: 0, claims: 0 };
      if (parts.length) setText(parts.join(', '));
    }, 10_000);
    return () => {
      unsub();
      clearInterval(iv);
    };
  }, []);

  return (
    <div className="sr" aria-live="polite" role="status">
      {text}
    </div>
  );
}
