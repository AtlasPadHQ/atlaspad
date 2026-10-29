/**
 * PanelHost — renders the shared PanelShell with the content for `store.panel`.
 * SHARED file (scaffold / integrator only).
 *
 *   place    → src/panel/PlacePanel      (PANEL builder)
 *   results  → src/search/ResultsList    (SEARCH builder)
 *   live     → src/feed/LivePanel        (RAIL+FEED builder)
 *   top      → src/feed/TopShopsPanel    (RAIL+FEED builder)
 *   launched → src/feed/LaunchedPanel    (RAIL+FEED builder)
 *   mine     → src/feed/MyCoinsPanel     (RAIL+FEED builder)
 *   help     → src/ui/HelpPanel          (shared)
 */
import LaunchedPanel from './feed/LaunchedPanel';
import LivePanel from './feed/LivePanel';
import MyCoinsPanel from './feed/MyCoinsPanel';
import TopShopsPanel from './feed/TopShopsPanel';
import { useIsMobile } from './lib/media';
import { isLaunchableSource } from './lib/place';
import PlacePanel from './panel/PlacePanel';
import ResultsList from './search/ResultsList';
import { useStore } from './store';
import type { PanelMode } from './types';
import { ErrorBoundary, PanelCrash } from './ui/ErrorBoundary';
import { HelpPanel } from './ui/HelpPanel';
import { PanelShell } from './ui/PanelShell';
import { useLatest, usePresence } from './ui/usePresence';

const LABELS: Record<Exclude<PanelMode, 'none'>, string> = {
  place: 'Place details',
  results: 'Search results',
  live: 'Live',
  top: 'Top shops',
  launched: 'Launched',
  mine: 'My coins',
  help: 'Help',
};

function Content({ mode }: { mode: Exclude<PanelMode, 'none'> }) {
  switch (mode) {
    case 'place':
      return <PlacePanel />;
    case 'results':
      return <ResultsList />;
    case 'live':
      return <LivePanel />;
    case 'top':
      return <TopShopsPanel />;
    case 'launched':
      return <LaunchedPanel />;
    case 'mine':
      return <MyCoinsPanel />;
    case 'help':
      return <HelpPanel />;
    default:
      return null;
  }
}

export default function PanelHost() {
  const mobile = useIsMobile();
  const panel = useStore((s) => s.panel);
  const collapsed = useStore((s) => s.panelCollapsed);
  const placeId = useStore((s) => s.selected.place?.id ?? null);
  // OSM / link places have no link that reopens them (panel/util shareBlockReason): no Share
  const shareable = useStore((s) => !!s.selected.place && isLaunchableSource(s.selected.place.source));
  const showBack = useStore((s) => s.panel === 'place' && s.panelHistory.length > 0);
  const panelNav = useStore((s) => s.panelNav);
  const resultsQuery = useStore((s) => s.resultsQuery);
  const closePanel = useStore((s) => s.closePanel);
  const setPanelCollapsed = useStore((s) => s.setPanelCollapsed);
  const openModal = useStore((s) => s.openModal);

  const open = panel !== 'none';
  const { mounted, state } = usePresence(open, mobile ? 300 : 200);
  const lastMode = useLatest<Exclude<PanelMode, 'none'>>(open ? (panel as Exclude<PanelMode, 'none'>) : null);
  if (!mounted || !lastMode) return null;
  const mode = open ? (panel as Exclude<PanelMode, 'none'>) : lastMode;

  const onShare = mode === 'place' && placeId && shareable ? () => openModal({ kind: 'share', placeId }) : undefined;

  return (
    <PanelShell
      ariaLabel={LABELS[mode]}
      state={state}
      collapsed={collapsed}
      onClose={closePanel}
      onCollapse={setPanelCollapsed}
      onShare={onShare}
      showBack={showBack}
      scrollKey={mode === 'place' ? `place:${placeId ?? ''}` : mode === 'results' ? `results:${resultsQuery}` : mode}
      restoreScroll={panelNav === 'back'}
    >
      <ErrorBoundary name={`panel:${mode}`} resetKey={`${mode}:${placeId ?? ''}`} fallback={({ reset }) => <PanelCrash reset={reset} />}>
        <Content mode={mode} />
      </ErrorBoundary>
    </PanelShell>
  );
}
