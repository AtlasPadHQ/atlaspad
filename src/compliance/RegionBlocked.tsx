/**
 * Blocking notice for a visitor in a geo-blocked region (src/compliance/regionBlock.ts, worker/geo.ts). Mounted once
 * next to <App/> in main.tsx; it renders nothing until an API call answers `region_blocked`, then covers the app (the
 * same card as the app-crash screen) and makes the rest of the page inert. Calm, final copy and no retry: reloading
 * from the same place shows the Worker's static 451 page. Terms, Privacy and the contact address stay reachable.
 */
import { useEffect, useRef } from 'react';
import { Icon } from '../ui/Icons';
import { useRegionBlocked } from './regionBlock';
import './compliance.css';

export const REGION_BLOCKED_TITLE = "AtlasPad isn't available in your region";
export const REGION_BLOCKED_BODY = "Because of sanctions and local rules, AtlasPad can't be used from where you are. Nothing in your wallet has changed.";
export const CONTACT_EMAIL = 'hello@atlaspad.online';

export default function RegionBlocked() {
  const on = useRegionBlocked();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!on || !el?.parentElement) return;
    // the app underneath can't be reached by keyboard or screen readers any more
    const others = [...el.parentElement.children].filter((c) => c !== el);
    for (const o of others) o.setAttribute('inert', '');
    el.querySelector<HTMLElement>('#region-blocked-t')?.focus();
    return () => {
      for (const o of others) o.removeAttribute('inert');
    };
  }, [on]);

  if (!on) return null;
  return (
    <div ref={ref} className="region-blocked" role="alertdialog" aria-modal="true" aria-labelledby="region-blocked-t" aria-describedby="region-blocked-b">
      <div className="empty">
        <span className="empty-ic">
          <Icon name="public" size={40} />
        </span>
        <h2 id="region-blocked-t" className="empty-t" tabIndex={-1}>
          {REGION_BLOCKED_TITLE}
        </h2>
        <p id="region-blocked-b" className="empty-b">
          {REGION_BLOCKED_BODY}
        </p>
        <p className="region-blocked-mail">
          Think this is a mistake? Write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
        <div className="empty-actions">
          <a className="btn btn-text" href="/terms">
            Terms
          </a>
          <a className="btn btn-text" href="/privacy">
            Privacy
          </a>
        </div>
      </div>
    </div>
  );
}
