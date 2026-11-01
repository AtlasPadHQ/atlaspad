/**
 * `Find a shop` / `Launch a coin` empty-state buttons (DESIGN §10.5, §13.4): the way forward from
 * an empty list (My coins with nothing in it; Live, Top shops and Launched before the first launch).
 *  - `Find a shop` → close the panel and focus the map;
 *  - `Launch a coin` → focus search with the link tip open (mobile: close the panel first).
 * Component-only file so Fast Refresh keeps working. OWNED BY RAIL+FEED.
 */
import { isMobileNow } from '../lib/media';
import { useStore } from '../store';
import { Button } from '../ui';

function findShop(): void {
  useStore.getState().closePanel();
  document.getElementById('map')?.focus({ preventScroll: true });
}

function launchCoin(): void {
  const st = useStore.getState();
  // on mobile the sheet would cover the full-screen search dropdown
  if (isMobileNow()) st.closePanel();
  st.focusSearch({ tip: true });
}

export function FirstLaunchActions() {
  return (
    <>
      <Button variant="outline" icon="storefront" onClick={findShop}>
        Find a shop
      </Button>
      <Button variant="primary" icon="rocket_launch" onClick={launchCoin}>
        Launch a coin
      </Button>
    </>
  );
}
