/**
 * The client address every per-IP limit is keyed on (worker/hmac.ts `ipHash`, the Phase-1 limits in worker/api.ts).
 * IPv6 is keyed on its /64: one subscriber line or host usually gets a whole /64, so the full address would let one
 * visitor walk through 2^64 addresses and every cap with them. IPv4 is unchanged, an IPv4-mapped IPv6 address
 * (`::ffff:203.0.113.5`) is its IPv4 address, and anything that is not an IP (`unknown`, `cron`) passes through as is.
 * Pure; never throws.
 */

/** `a.b.c.d` → its four octets, or null. */
function ipv4Octets(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : null;
}

/** An IPv6 address (`::` shorthand and a dotted IPv4 tail allowed) → its eight 16-bit groups, or null. */
function ipv6Groups(s: string): number[] | null {
  let str = s;
  const tail = /^(.*:)([^:]*\.[^:]*)$/.exec(str);
  if (tail) {
    const o = ipv4Octets(tail[2]!);
    if (!o) return null;
    str = `${tail[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const parts = (h: string) => (h === '' ? [] : h.split(':'));
  const head = parts(halves[0]!);
  const rest = halves.length === 2 ? parts(halves[1]!) : [];
  const all = [...head, ...rest];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  if (halves.length === 1 ? head.length !== 8 : all.length > 7) return null;
  const groups = [...head, ...Array<string>(8 - all.length).fill('0'), ...rest];
  return groups.map((g) => parseInt(g, 16));
}

/**
 * `198.51.100.7` → `198.51.100.7`; `2001:db8:1:2:3:4:5:6` and `2001:0db8:0001:0002::9` → `2001:db8:1:2::/64`;
 * `::ffff:198.51.100.7` → `198.51.100.7`.
 */
export function ipKey(ip: string): string {
  const s = ip.trim();
  if (!s.includes(':')) return s;
  const g = ipv6Groups(s.replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  if (!g) return s;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255].join('.');
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}
