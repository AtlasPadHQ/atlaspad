/**
 * Website ownership markers ("Code on your website", INTEGRATION §3.5). Pure strings, shared by the Worker checker
 * (worker/website.ts) and the claim UI (src/claim/RealClaimFlow.tsx), so both always name the same tag and file.
 *
 * Primary: `<meta name="atlaspad-verify" content="7KQ2-M9XD">` in the home page's <head>, or the plain-text file
 * `/.well-known/atlaspad.txt`. The CORNERSHOP-era `cornershop-verify` tag and `/.well-known/cornershop.txt` stay
 * accepted, so codes issued and files published before the rename keep working. The secret is the 8-character value;
 * the prefix is only a label, so any listed prefix (or none) matches.
 */

/** Meta tag names, primary first. */
export const VERIFY_META_NAMES = ['atlaspad-verify', 'cornershop-verify'] as const;
export const VERIFY_META_NAME = VERIFY_META_NAMES[0];

/** Well-known file paths, primary first (the checker tries them in this order). */
export const WELL_KNOWN_PATHS = ['/.well-known/atlaspad.txt', '/.well-known/cornershop.txt'] as const;
export const WELL_KNOWN_PATH = WELL_KNOWN_PATHS[0];

/** `atlaspad-verify=7KQ2-M9XD` (or the legacy `cornershop-verify=…`) → `7KQ2-M9XD`. */
export function websiteCodeValue(code: string): string {
  for (const name of VERIFY_META_NAMES) if (code.startsWith(`${name}=`)) return code.slice(name.length + 1);
  return code;
}

/** Every text that proves `code`: the bare value and the value under each accepted prefix. */
export function websiteCodeForms(code: string): string[] {
  const value = websiteCodeValue(code);
  return [value, ...VERIFY_META_NAMES.map((n) => `${n}=${value}`)];
}

/** The tag an owner pastes into their home page's <head> (always the primary name). */
export function websiteMetaTag(code: string): string {
  return `<meta name="${VERIFY_META_NAME}" content="${websiteCodeValue(code)}">`;
}
