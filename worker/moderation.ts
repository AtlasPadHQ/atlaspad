/**
 * Launch-text moderation (INTEGRATION §3.3 step 6): a small blocklist for coin names, tickers and descriptions —
 * slurs, "official"/impersonation of well-known brands, and scam bait. Matching runs on a normalised form
 * (lower case, accents, fullwidth and Cyrillic / Greek look-alikes folded, leetspeak folded, separators removed) so
 * "0fficial", "f.r.e.e s.o.l", "MCD0NALDS" and "Ｓｏｌａｎａ" are caught.
 * This is a first filter; hidden coins (`coins.status='hidden'`) and /api/report cover the rest.
 */

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i', '|': 'i' };

/** Cyrillic / Greek letters (lower case) that read as Latin ones: "AtlasPad" spelt with a Cyrillic A is still our brand. */
const LOOKALIKE: Record<string, string> = {
  '\u0430': 'a', '\u0432': 'b', '\u0435': 'e', '\u043a': 'k', '\u043c': 'm', '\u043d': 'h', '\u043e': 'o', '\u0440': 'p',
  '\u0441': 'c', '\u0442': 't', '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0458': 'j', '\u0455': 's', '\u0501': 'd',
  '\u04cf': 'l', '\u04bb': 'h', '\u051b': 'q', '\u051d': 'w', // Cyrillic
  '\u03b1': 'a', '\u03b2': 'b', '\u03b5': 'e', '\u03b9': 'i', '\u03ba': 'k', '\u03bf': 'o', '\u03c1': 'p', '\u03c4': 't', '\u03c7': 'x', // Greek
};

/**
 * Lower case with accents removed, compatibility forms folded (fullwidth, mathematical bold, circled letters -> ASCII)
 * and look-alike letters mapped to Latin. Done BEFORE words are split, so an accented, fullwidth or Cyrillic letter
 * doesn't break a word in two.
 */
function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, (c) => LOOKALIKE[c] ?? c);
}

export function normalizeForModeration(s: string): string {
  return fold(s)
    .replace(/[0-9@$!|]/g, (c) => LEET[c] ?? c)
    .replace(/[^a-z]/g, '');
}

/** Long, unambiguous substrings (normalised) that are never allowed anywhere in the text. */
const BLOCKED: readonly string[] = [
  // impersonation / authority
  'official', 'pumpfun', 'pumpdotfun', 'coinbase', 'binance', 'metamask', 'trustwallet',
  // scam bait
  'airdrop', 'giveaway', 'freesol', 'freemoney', 'presale', 'guaranteed', 'doubleyour', 'claimnow', 'walletconnect',
  'seedphrase', 'privatekey', 'rugpull',
  // slurs / hate (long stems only; short ones are whole-word below to avoid "Spice Bar" / "Grape Vine" misfires)
  'nigger', 'nigga', 'faggot', 'tranny', 'wetback', 'hitler',
];

/**
 * Whole normalised words only. Crypto / platform names people use to impersonate support or the chain itself, a few
 * tech megabrands, base-asset tickers, and short slur stems. Food and retail chains are NOT blocked: a branch of a
 * chain is a real business that may be launched; trademark complaints go through /api/report (takedown).
 */
const BLOCKED_WORDS: readonly string[] = [
  'verified', 'support', 'admin', 'solana', 'phantom', 'solflare', 'kraken', 'jupiter', 'raydium', 'tether', 'usdc',
  'usdt', 'atlaspad', 'cornershop', 'google', 'microsoft', 'amazon', 'tesla',
  'sol', 'usd', 'btc', 'eth', 'scam', 'rug', 'kys',
  'retard', 'chink', 'spic', 'kike', 'paki', 'coon', 'gook', 'nazi', 'kkk', 'pedo', 'rape', 'rapist',
];

/**
 * Our own brand: a coin must never read as issued by us. Caught as a word ("AtlasPad"), spelt across consecutive words
 * ("Atlas Pad", "ATLAS-PAD", "A.T.L.A.S.P.A.D"), in camel case ("AtlasPadCoin") and inside a longer word ("ATLASPADX",
 * "theatlaspad", "atlaspadcoin", "Atlas Padtoken"). The only exceptions are the real words in OWN_BRAND_REAL ("Atlas
 * Padel Club", "Atlas Paddington"), judged on whole words (camel case splits them: "AtlasPadelClub"), never on the text
 * with its spaces taken out, so a word after the brand cannot hide it ("AtlasPad Elite"). A run across words is judged
 * the same way wherever it starts, so "Tapas at Las Padillas" is refused too: rare, and the spelling an impersonator
 * would use.
 */
const OWN_BRAND = 'atlaspad';
/** The real words allowed after "Atlas" that begin "pad", from the brand to the end of the word. */
const OWN_BRAND_REAL = /^atlaspad(?:el|dles?|dling|dleboards?|dleboarding|docks?|dington|stow|ua|res?|ang)$/;

/** Our brand in consecutive words (see OWN_BRAND); null when absent. */
function brandRun(words: readonly string[]): string | null {
  const ends: number[] = [];
  let joined = '';
  for (const w of words) ends.push((joined += w).length);
  for (let k = joined.indexOf(OWN_BRAND); k >= 0; k = joined.indexOf(OWN_BRAND, k + 1)) {
    const last = ends.findIndex((e) => e >= k + OWN_BRAND.length);
    // the brand to the end of the word it ends in
    if (!OWN_BRAND_REAL.test(joined.slice(k, ends[last]))) return OWN_BRAND;
  }
  return null;
}

export function moderationHit(...texts: string[]): string | null {
  for (const t of texts) {
    if (!t) continue;
    const n = normalizeForModeration(t);
    for (const b of BLOCKED) if (n.includes(b)) return b;
    const words = (f: string, sep: RegExp) => f.split(sep).filter(Boolean).map((w) => normalizeForModeration(w));
    // separators split words; a second pass keeps @ and $ inside them, so "Atl@sPad" reads as leetspeak, not two words
    const PLAIN = /[^a-z0-9]+/;
    const LEET = /[^a-z0-9@$]+/;
    const f = fold(t);
    for (const sep of [PLAIN, LEET]) {
      const w = words(f, sep).find((x) => BLOCKED_WORDS.includes(x));
      if (w) return w;
    }
    // our brand reads camel case as words too ("AtlasPadCoin", "AtlasPadDock", and the real "AtlasPadelClub"); other
    // blocked words keep the whole-word rule. Camel case only adds word ends: the brand is still found, and passes only
    // when it ends in a real word.
    // a word ends before an upper-case letter that follows a lower-case one ("Atlas|Pad"), and before the last capital
    // of a run that starts a capitalised word ("ATLASPAD|Elite"), unless that is a plural "s" ("PADDLEs")
    const camel = fold(t.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(?=\p{Lu}\p{Ll})(?!\p{Lu}s(?![\p{L}\p{N}]))/gu, '$1 '));
    const brand = brandRun(words(camel, PLAIN)) ?? brandRun(words(camel, LEET));
    if (brand) return brand;
  }
  return null;
}

/** URLs / domains are not allowed in names (phishing). */
export function containsUrl(s: string): boolean {
  return /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|io|xyz|net|org|app|fun|gg|co|me|sh|so|ly|to|link|site|online|club|top)\b)/i.test(s);
}

/** Generic top-level domains that read as a link in free text. */
const GTLDS =
  'com|net|org|io|xyz|app|fun|gg|co|me|sh|so|ly|to|link|site|online|club|top|info|biz|dev|live|shop|store|vip|pro|' +
  'finance|money|exchange|wallet|claim|tech|ai|cc|ws|tk|ml|ga|cf|gq|win|bid|click|lol|meme|page|art|world|bet|cash|' +
  'trade|network|digital|today|email|gift|games|lat|zone|space|website|cloud|run|news|blog|one|xxx';
/** A written-out domain: `name.tld` (any 2-letter ccTLD too) with NO spaces, as real domains are written. */
const DOMAIN_RE = new RegExp(`\\b[a-z0-9-]+\\.(?:[a-z0-9-]+\\.)*(?:${GTLDS}|[a-z]{2})\\b`, 'i');
/** Obfuscated domains: `evil[.]com`, `evil(.)com`, `evil [dot] com`, `evil dot com`, `evil . com` (gTLDs only). */
const OBFUSCATED_RE = new RegExp(`\\b[a-z0-9-]{2,}\\s*(?:\\[\\.\\]|\\(\\.\\)|\\[dot\\]|\\(dot\\)|\\sdot\\s|\\s\\.\\s)\\s*(?:${GTLDS})\\b`, 'i');
const SCHEME_OR_IP_RE = /(\b(?:https?|hxxps?|ftp):|\bwww\.|\b\d{1,3}(?:\.\d{1,3}){3}\b)/i;

/**
 * Coin DESCRIPTIONS may not carry links either (they are shown by wallets and pump.fun next to a real shop's name, so
 * a URL there is a phishing vector). Stricter than `containsUrl` (names): any TLD, scheme-less domains, obfuscations
 * like "evil . com" / "evil[.]com" / "evil dot com", and bare IPs.
 */
export function containsLink(s: string): boolean {
  const t = s.normalize('NFKC');
  return containsUrl(t) || SCHEME_OR_IP_RE.test(t) || DOMAIN_RE.test(t) || OBFUSCATED_RE.test(t);
}

/** Control and zero-width / bidi characters (spoofing). */
export function hasInvisible(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(s);
}
