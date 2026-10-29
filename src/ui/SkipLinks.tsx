/**
 * "Skip to map" / "Skip to panel" (DESIGN §15): first focusable elements, visually hidden until
 * focused. The map container must be focusable (`#map` gets tabIndex=0 from MapView).
 * SHARED (src/ui).
 */
import { useStore } from '../store';

function focusSel(sel: string) {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) return;
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus();
}

export function SkipLinks() {
  const panelOpen = useStore((s) => s.panel !== 'none');
  return (
    <div className="skip-links">
      <a
        href="#map"
        className="skip"
        onClick={(e) => {
          e.preventDefault();
          focusSel('#map');
        }}
      >
        Skip to map
      </a>
      {panelOpen ? (
        <a
          href="#panel"
          className="skip"
          onClick={(e) => {
            e.preventDefault();
            focusSel('.panel .panel-scroll');
          }}
        >
          Skip to panel
        </a>
      ) : null}
    </div>
  );
}
