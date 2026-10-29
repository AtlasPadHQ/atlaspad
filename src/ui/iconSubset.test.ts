/**
 * Material Symbols is loaded as a SUBSET (index.html `icon_names=`). An icon name missing from that list renders as its
 * literal text ("science", "water_drop"…). This test scans the app for icon names used as literals and requires every
 * one to be in the subset, and the list to stay alphabetical (Google Fonts requires it).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

describe('icon font subset', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const subset = (/icon_names=([^&"]+)/.exec(html)?.[1] ?? '').split(',');

  it('is alphabetical', () => {
    expect(subset.length).toBeGreaterThan(10);
    expect([...subset].sort()).toEqual(subset);
  });

  it('contains every icon name the app uses as a literal', () => {
    const used = new Map<string, string>();
    const patterns = [
      /<Icon\b[^>]*?\bname=["']([a-z_0-9]+)["']/g, // <Icon name="x" />
      /<Icon\b[^>]*?\bname=\{([^}]*)\}/g, // <Icon name={cond ? 'a' : 'b'} />
      /\bicon=["']([a-z_0-9]+)["']/g, // <Button icon="x">
      /\bicon=\{([^}]*)\}/g,
    ];
    for (const f of files(join(ROOT, 'src'))) {
      const src = readFileSync(f, 'utf8');
      for (const re of patterns) {
        for (const m of src.matchAll(re)) {
          // `name={expr}`: only the quoted literals inside the expression (a bare identifier is a variable)
          const names = re.source.includes('\\{') ? [...m[1]!.matchAll(/['"]([a-z_0-9]+)['"]/g)].map((x) => x[1]!) : [m[1]!];
          for (const n of names) if (/^[a-z][a-z_0-9]+$/.test(n)) used.set(n, f.slice(ROOT.length + 1));
        }
      }
    }
    const missing = [...used].filter(([n]) => !subset.includes(n)).map(([n, f]) => `${n} (${f})`);
    expect(missing).toEqual([]);
  });
});
