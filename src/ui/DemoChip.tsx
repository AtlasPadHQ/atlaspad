/**
 * DEMO chip (DESIGN §6.4) — a <button> that opens the DEMO explainer; never dismissible.
 * Desktop label `DEMO · simulated prices`; tablet/mobile `DEMO · simulated`.
 * Real mode (INTEGRATION.md §7.1): the DEVNET chip in the same slot (`DEVNET · test SOL` /
 * `DEVNET · test`) opens the devnet explainer; mainnet shows no chip.
 * Plus the "Basic map" chip shown when the MapLibre/OSM fallback is active (DESIGN §13.5), and the
 * blocking network banner (real mode: cluster mismatch / API unreachable on boot).
 * SHARED (src/ui).
 */
import { CLUSTER, IS_REAL } from '../mode';
import { useStore } from '../store';
import { Icon } from './Icons';

/** `full` forces the long label at every width (mobile drawer footer). */
export function DemoChip({ full, className }: { full?: boolean; className?: string }) {
  const openModal = useStore((s) => s.openModal);
  return (
    <button
      type="button"
      className={['demo-chip', 'hit', full ? 'demo-full' : '', className ?? ''].filter(Boolean).join(' ')}
      data-tip="Prices and trades are simulated. No real transactions."
      onClick={() => openModal({ kind: 'demo' })}
    >
      <i aria-hidden="true" />
      DEMO
      <span className="demo-long"> · simulated prices</span>
      <span className="demo-short"> · simulated</span>
    </button>
  );
}

/** DEVNET chip (real mode on devnet). Same slot and shape as the DEMO chip. */
export function NetworkChip({ full, className }: { full?: boolean; className?: string }) {
  const openModal = useStore((s) => s.openModal);
  return (
    <button
      type="button"
      className={['demo-chip', 'net-chip', 'hit', full ? 'demo-full' : '', className ?? ''].filter(Boolean).join(' ')}
      data-tip="Solana devnet: test SOL with no value."
      onClick={() => openModal({ kind: 'network' })}
    >
      <i aria-hidden="true" />
      DEVNET
      <span className="demo-long"> · test SOL</span>
      <span className="demo-short"> · test</span>
    </button>
  );
}

/** The chip for this mode: DEMO (demo), DEVNET (real devnet), nothing (mainnet). */
export function ModeChip(props: { full?: boolean; className?: string }) {
  if (!IS_REAL) return <DemoChip {...props} />;
  if (CLUSTER === 'devnet') return <NetworkChip {...props} />;
  return null;
}

export function BasicMapChip({ className }: { className?: string }) {
  const provider = useStore((s) => s.provider);
  if (provider !== 'demo') return null;
  return (
    <span
      className={['basic-chip', className ?? ''].filter(Boolean).join(' ')}
      tabIndex={0}
      role="note"
      data-tip="Google Maps is unavailable. Showing OpenStreetMap; launching is paused."
      aria-label="Basic map. Google Maps is unavailable. Showing OpenStreetMap; launching is paused."
    >
      <Icon name="info" size={16} />
      <span className="basic-lbl">Basic map</span>
    </span>
  );
}

/**
 * Real mode, blocking states of the network (INTEGRATION.md §1.3): the Worker serves another
 * cluster than this build ("Network mismatch. Reload, or open the demo.") — the app then stays
 * read-only — or `/api/config` never loaded.
 */
export function ChainBanner() {
  const status = useStore((s) => s.chain.status);
  if (!IS_REAL || (status !== 'mismatch' && status !== 'error')) return null;
  const mismatch = status === 'mismatch';
  return (
    <div className={['chain-banner', mismatch ? 'bad' : ''].filter(Boolean).join(' ')} role={mismatch ? 'alert' : 'status'}>
      <Icon name={mismatch ? 'error' : 'cloud_off'} />
      <span>{mismatch ? 'Network mismatch. Reload, or open the demo.' : "We can't reach the network right now. Retrying…"}</span>
      {mismatch ? (
        <>
          <button type="button" className="link hit" onClick={() => location.reload()}>
            Reload
          </button>
          <a className="link hit" href="/?mode=demo">
            Open the demo
          </a>
        </>
      ) : null}
    </div>
  );
}
