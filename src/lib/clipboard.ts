/**
 * Clipboard with toast + fallback (DESIGN §16.11: "Mint address copied", "Link copied",
 * "Address copied"). SHARED (src/lib). Browser-only.
 */
import { useStore } from '../store';

/** Copy text. Uses the async Clipboard API, falling back to a hidden textarea + execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    const selection = document.getSelection();
    const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
    return ok;
  } catch {
    return false;
  }
}

/**
 * Copy and confirm with a toast (`Link copied`). On failure shows
 * "Couldn't copy. Select and copy it manually." Returns whether the copy worked.
 */
export async function copyWithToast(text: string, successMessage: string): Promise<boolean> {
  const ok = await copyText(text);
  const { toast } = useStore.getState();
  if (ok) toast(successMessage, 'ok');
  else toast("Couldn't copy. Select and copy it manually.", 'error');
  return ok;
}
