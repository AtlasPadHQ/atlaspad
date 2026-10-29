/**
 * The fixed affiliation disclaimer at the end of every new coin's metadata description (Terms "Launching a coin").
 * Wallets, explorers and pump.fun show that description next to a real business's name, forever, so it always says the
 * coin is a community coin. The whole description stays within DESCRIPTION_MAX_CHARS: the launcher's text is shortened
 * (with an ellipsis), never the disclaimer.
 */
import { DESCRIPTION_MAX_CHARS } from './wire';

export const COIN_DISCLAIMER = 'Community coin. Not affiliated with this business unless claimed on atlaspad.online.';
const SEP = '\n\n';
const ELLIPSIS = '…';

function graphemes(s: string): string[] {
  try {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map((g) => g.segment);
  } catch {
    return [...s];
  }
}

/**
 * The launcher's (already cleaned) text, cut to fit, then the disclaimer. Lengths are counted in code points like
 * `cleanDescription`; the cut falls on a grapheme boundary so no emoji or accent is split.
 */
export function withDisclaimer(text: string, max: number = DESCRIPTION_MAX_CHARS): string {
  const user = text.trim();
  if (!user) return COIN_DISCLAIMER;
  const budget = max - [...COIN_DISCLAIMER].length - SEP.length;
  if (budget <= ELLIPSIS.length) return COIN_DISCLAIMER;
  if ([...user].length <= budget) return `${user}${SEP}${COIN_DISCLAIMER}`;
  let out = '';
  let used = 0;
  for (const g of graphemes(user)) {
    const n = [...g].length;
    if (used + n > budget - ELLIPSIS.length) break;
    out += g;
    used += n;
  }
  return `${out.trimEnd()}${ELLIPSIS}${SEP}${COIN_DISCLAIMER}`;
}
