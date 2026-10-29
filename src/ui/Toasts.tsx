/**
 * Toast host (DESIGN §13.1): one toast at a time (a new one replaces the old), auto-dismiss
 * 4s (6s with an action), hover/focus pauses, role="status" (errors role="alert"), optional
 * leading icon and one trailing text action. Mounted once by App. SHARED (src/ui).
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import type { Toast } from '../types';
import { Icon } from './Icons';

function ToastView({ toast }: { toast: Toast }) {
  const dismissToast = useStore((s) => s.dismissToast);
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.action ? 6000 : 4000);
  const startedAt = useRef(0);

  useEffect(() => {
    if (paused) return;
    startedAt.current = Date.now();
    const t = setTimeout(() => dismissToast(toast.id), remaining.current);
    return () => {
      clearTimeout(t);
      remaining.current = Math.max(800, remaining.current - (Date.now() - startedAt.current));
    };
  }, [paused, toast.id, dismissToast]);

  const icon = toast.icon ?? (toast.kind === 'ok' ? 'check_circle' : toast.kind === 'error' ? 'error' : null);
  return (
    <div
      className="toast show"
      role={toast.kind === 'error' ? 'alert' : 'status'}
      aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {icon ? <Icon name={icon} className={toast.kind === 'ok' ? 'ok' : toast.kind === 'error' ? 'bad' : ''} /> : null}
      <span className="toast-msg">{toast.msg}</span>
      {toast.action ? (
        <button
          type="button"
          className="act-t"
          onClick={() => {
            toast.action?.run();
            dismissToast(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
    </div>
  );
}

export function Toasts() {
  const toast = useStore((s) => s.toasts[s.toasts.length - 1]);
  if (!toast) return null;
  // key → a replaced toast remounts (fresh timer + enter animation)
  return <ToastView key={toast.id} toast={toast} />;
}
