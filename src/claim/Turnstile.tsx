/**
 * Cloudflare Turnstile widget for the claim call (DESIGN §12.3 "Turnstile widget slot", INTEGRATION.md
 * §1.9). Rendered only when `/api/config` carries a `turnstileSiteKey` (mainnet); the script loads on
 * demand from challenges.cloudflare.com. 300×65, centred. Calls `onToken` with each fresh token
 * (and null when it expires / errors).
 */
import { useEffect, useRef } from 'react';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  remove(id: string): void;
  reset(id?: string): void;
}

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  const w = window as unknown as { turnstile?: TurnstileApi };
  if (w.turnstile) return Promise.resolve(w.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error('turnstile missing')));
    s.onerror = () => {
      loading = null;
      reject(new Error('turnstile failed to load'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export function Turnstile({ siteKey, onToken, resetKey }: { siteKey: string; onToken: (token: string | null) => void; resetKey?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  useEffect(() => {
    let id: string | null = null;
    let api: TurnstileApi | null = null;
    let on = true;
    loadTurnstile()
      .then((t) => {
        if (!on || !ref.current) return;
        api = t;
        id = t.render(ref.current, {
          sitekey: siteKey,
          size: 'normal',
          callback: (token: string) => cb.current(token),
          'expired-callback': () => cb.current(null),
          'error-callback': () => cb.current(null),
        });
      })
      .catch(() => cb.current(null));
    return () => {
      on = false;
      if (api && id) api.remove(id);
    };
  }, [siteKey, resetKey]);
  return <div ref={ref} className="cl-turnstile" />;
}
