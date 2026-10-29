/**
 * Layered Escape handling (DESIGN §15): "Esc closes one layer per press:
 * dropdown/popover → modal → drawer → mobile sheet/panel".
 * Components register a handler while open; only the most recently registered (top) layer
 * receives Esc. Priority breaks ties so a popover opened inside a modal still wins.
 * SHARED (src/lib).
 */
import { useEffect, useRef } from 'react';

/** Higher = closer to the user. */
export const ESC_PRIORITY = {
  panel: 10,
  drawer: 20,
  modal: 30,
  popover: 40,
  dropdown: 40,
  lightbox: 50,
} as const;

interface Layer {
  id: number;
  priority: number;
  handler: () => boolean | void;
}

const layers: Layer[] = [];
let seq = 0;
let installed = false;

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  // highest priority, then most recent
  const sorted = [...layers].sort((a, b) => b.priority - a.priority || b.id - a.id);
  for (const layer of sorted) {
    // a handler may return false to say "not handled, try the next layer"
    if (layer.handler() !== false) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', onKeyDown, true);
}

/** Imperative registration. Returns an unregister function. */
export function pushEscapeLayer(handler: () => boolean | void, priority: number = ESC_PRIORITY.modal): () => void {
  install();
  const layer: Layer = { id: ++seq, priority, handler };
  layers.push(layer);
  return () => {
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
  };
}

/**
 * Hook: while `active`, Esc calls `handler` (if this is the top layer).
 * Return false from the handler to let the next layer handle Esc (e.g. a busy modal).
 */
export function useEscapeLayer(active: boolean, handler: () => boolean | void, priority: number = ESC_PRIORITY.modal): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    return pushEscapeLayer(() => ref.current(), priority);
  }, [active, priority]);
}
