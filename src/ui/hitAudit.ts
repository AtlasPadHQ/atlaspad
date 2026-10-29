/**
 * Mobile hit-area audit (Phase-1 minor #1, INTEGRATION.md §7.8): every interactive element must
 * offer at least 44×44 px at < 768 px. The effective target is the element's box or its `::after`
 * hit extender (`.hit`, `.btn`, `.icon-btn`, text links — see styles/global.css), whichever is larger.
 *
 * Loaded on demand (dev builds, or `?qa=1`) as `window.__csHitAudit()`; the Browser-pane QA pass
 * runs it at 375 px on every screen. Pure helpers are unit-tested (hitAudit.test.ts).
 */

export interface HitIssue {
  /** Short CSS-ish path for the report, e.g. `button.link-btn` or `a.irow`. */
  what: string;
  /** Accessible name / text (trimmed). */
  label: string;
  w: number;
  h: number;
}

export const MIN_HIT = 44;

/** Controls we audit. Google-owned UI Kit elements and the map canvas are excluded (not ours). */
export const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="tab"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="checkbox"]',
].join(',');

const EXCLUDE = 'gmp-place-details, gmp-place-details-compact, [class*="gmp-"], #map, .gm-style, .maplibregl-map, .sr, [aria-hidden="true"]';

/** Pixel value of a computed length ("44px" → 44; "auto"/"" → 0). */
export function px(v: string | null | undefined): number {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : 0;
}

/** Effective tap size: max(box, ::after extender when it is rendered and absolutely positioned). */
export function effectiveSize(box: { width: number; height: number }, after: { content: string; position: string; width: string; height: string } | null): { w: number; h: number } {
  let w = box.width;
  let h = box.height;
  if (after && after.content && after.content !== 'none' && after.content !== 'normal' && after.position === 'absolute') {
    w = Math.max(w, px(after.width));
    h = Math.max(h, px(after.height));
  }
  return { w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10 };
}

function describe(el: Element): string {
  const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join('.') : '';
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
}

function labelOf(el: Element): string {
  const a = el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? el.textContent ?? '';
  return a.replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Visible controls under `root` whose effective target is smaller than `min` px. */
export function auditHitAreas(root: ParentNode = document, min = MIN_HIT): HitIssue[] {
  const out: HitIssue[] = [];
  for (const el of Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR))) {
    if (el.closest(EXCLUDE)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue; // not rendered
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const after = getComputedStyle(el, '::after');
    let { w, h } = effectiveSize(r, { content: after.content, position: after.position, width: after.width, height: after.height });
    // a checkbox / radio inside its <label>: tapping anywhere on the label toggles it, so the label is the target
    const label = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? el.closest('label') : null;
    if (label) {
      const lr = label.getBoundingClientRect();
      w = Math.max(w, Math.round(lr.width * 10) / 10);
      h = Math.max(h, Math.round(lr.height * 10) / 10);
    }
    if (w + 0.5 < min || h + 0.5 < min) out.push({ what: describe(el), label: labelOf(el), w, h });
  }
  return out;
}

/** `window.__csHitAudit()` for the QA pass. */
export function installHitAudit(): void {
  (window as unknown as { __csHitAudit?: () => HitIssue[] }).__csHitAudit = () => auditHitAreas(document);
}
