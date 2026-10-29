/**
 * Layers (DESIGN §6.7, §18.1): the 79×79 desktop/tablet tile (bottom-left) toggles a popover to its
 * right; on mobile a 44px Layers FAB opens the same content as a bottom sheet.
 *  - Map type: Default (`roadmap`) / Satellite (`hybrid`) → store.setLayers → adapter.setMapType.
 *    The OpenStreetMap fallback has no imagery, so Satellite is unavailable there (aria-disabled,
 *    tooltip + toast explain why).
 *  - On the map: Coins · Fees waiting dots · Live trade flashes · Owner-verified ticks.
 * Everything persists in localStorage `cs_layers` (store). Close: click outside, Esc, the tile again.
 * Contract: default export, no props.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useIsMobile } from '../lib/media';
import { useStore } from '../store';
import type { MapType } from '../types';
import { Icon, Modal, ModalHeader, Popover, ToggleRow } from '../ui';
import './map.css';

const SATELLITE_UNAVAILABLE = 'Satellite needs Google Maps. The basic map has no imagery.';

const MAP_TYPES: readonly { key: MapType; label: string }[] = [
  { key: 'roadmap', label: 'Default' },
  { key: 'hybrid', label: 'Satellite' },
];

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

function LayersContent({ autoFocus }: { autoFocus?: boolean }) {
  const layers = useStore((s) => s.layers);
  const setLayers = useStore((s) => s.setLayers);
  const provider = useStore((s) => s.provider);
  const toast = useStore((s) => s.toast);
  const typeLabel = useId();
  const onMapLabel = useId();
  const refs = useRef<Record<MapType, HTMLButtonElement | null>>({ roadmap: null, hybrid: null });

  const satelliteOk = provider === 'google';
  const current: MapType = satelliteOk ? layers.mapType : 'roadmap';

  // Popover: move focus into the panel (on the selected map type) when it opens.
  const initial = useRef(current);
  useEffect(() => {
    if (autoFocus) refs.current[initial.current]?.focus({ preventScroll: true });
  }, [autoFocus]);

  const choose = (t: MapType) => {
    if (t === 'hybrid' && !satelliteOk) {
      toast(SATELLITE_UNAVAILABLE, 'info', undefined, 'info');
      return;
    }
    if (t !== layers.mapType) setLayers({ mapType: t });
  };

  // Radio group keyboard pattern: arrows move + select.
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!ARROWS.has(e.key)) return;
    e.preventDefault();
    const next: MapType = current === 'roadmap' ? 'hybrid' : 'roadmap';
    if (next !== 'hybrid' || satelliteOk) choose(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="lyr">
      <div className="lyr-h" id={typeLabel}>
        Map type
      </div>
      <div className="lyr-types" role="radiogroup" aria-labelledby={typeLabel}>
        {MAP_TYPES.map((t) => {
          const on = current === t.key;
          const unavailable = t.key === 'hybrid' && !satelliteOk;
          return (
            <button
              key={t.key}
              ref={(el) => {
                refs.current[t.key] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={unavailable || undefined}
              tabIndex={on ? 0 : -1}
              data-autofocus={on ? '' : undefined}
              data-tip={unavailable ? SATELLITE_UNAVAILABLE : undefined}
              className={['lyr-type', on ? 'on' : ''].filter(Boolean).join(' ')}
              onClick={() => choose(t.key)}
              onKeyDown={onKeyDown}
            >
              <span className={`lyr-thumb ${t.key}`} aria-hidden="true" />
              <span className="lyr-l">{t.label}</span>
            </button>
          );
        })}
      </div>
      <div className="lyr-h lyr-h2" id={onMapLabel}>
        On the map
      </div>
      <div className="lyr-rows" role="group" aria-labelledby={onMapLabel}>
        <ToggleRow label="Coins" checked={layers.coins} onChange={(v) => setLayers({ coins: v })} />
        <ToggleRow label="Fees waiting dots" checked={layers.feeDots} onChange={(v) => setLayers({ feeDots: v })} />
        <ToggleRow label="Live trade flashes" checked={layers.flashes} onChange={(v) => setLayers({ flashes: v })} />
        <ToggleRow label="Owner-verified ticks" checked={layers.ticks} onChange={(v) => setLayers({ ticks: v })} />
      </div>
    </div>
  );
}

export default function LayersTile() {
  const mobile = useIsMobile();
  const [popover, setPopover] = useState(false);
  const [sheet, setSheet] = useState(false);
  const tileRef = useRef<HTMLButtonElement>(null);
  const sheetTitle = useId();

  // Crossing the 768px breakpoint closes whichever surface was open.
  useEffect(() => {
    setPopover(false);
    setSheet(false);
  }, [mobile]);

  const closePopover = useCallback(() => setPopover(false), []);
  const closeSheet = useCallback(() => setSheet(false), []);

  return (
    <>
      <button
        ref={tileRef}
        type="button"
        className="layers"
        aria-label="Layers"
        aria-haspopup="dialog"
        aria-expanded={popover}
        onClick={() => setPopover((o) => !o)}
      >
        <span className="mini" aria-hidden="true" />
        <span className="lab" aria-hidden="true">
          <Icon name="layers" />
          Layers
        </span>
      </button>
      <Popover
        anchor={tileRef}
        open={popover && !mobile}
        onClose={closePopover}
        placement="right-end"
        width={296}
        className="layers-pop"
        ariaLabel="Layers"
      >
        <LayersContent autoFocus />
      </Popover>

      <button
        type="button"
        className="m-fab layers-fab"
        aria-label="Layers"
        aria-haspopup="dialog"
        aria-expanded={sheet}
        onClick={() => setSheet(true)}
      >
        <Icon name="layers" />
      </button>
      <Modal open={sheet && mobile} onClose={closeSheet} labelledBy={sheetTitle} className="layers-sheet">
        <ModalHeader onClose={closeSheet} lead={<h2 id={sheetTitle}>Layers</h2>} />
        <LayersContent />
      </Modal>
    </>
  );
}
