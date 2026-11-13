// node --test scripts/test/   (README.md against the repository: every workflow badge names a workflow in
// .github/workflows, every image is a tracked file or a badge, relative links and their #anchors resolve, the explorer
// link is the mainnet program, and the "How it works" diagram names only shop_vault instructions that SPEC.md §5
// specifies and pump.fun instructions SPEC.md uses, so a renamed workflow or instruction cannot silently break it).
// Repository files only: no network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { ORIGINS, PROGRAM_ID, ROOT } from '../lib/paths.mjs';

const REPO = 'https://github.com/AtlasPadHQ/atlaspad';
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const README = read('README.md');
const SPEC_PATH = 'programs/shop-vault/SPEC.md';
const SPEC = read(SPEC_PATH);

/** The text outside fenced code blocks (their lines become empty, so line numbers stay put). */
const prose = (md) => md.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, (block) => block.replace(/[^\n]/g, ''));

/** Image sources: Markdown `![alt](src)` and HTML `<img src>`, outside code blocks. */
function images(md) {
  const text = prose(md);
  return [...[...text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]), ...[...text.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1])];
}

/** Link targets `[text](target)`, outside code blocks (images included: their target is the src). */
const links = (md) => [...prose(md).matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]);

/** GitHub's heading anchors (github-slugger): lower case, punctuation dropped, spaces to hyphens, -1/-2 for repeats. */
function anchors(md) {
  const seen = new Map();
  const out = new Set();
  for (const [, heading] of prose(md).matchAll(/^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gm)) {
    const base = heading.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

/** The README's Mermaid blocks. */
const mermaidBlocks = (md) => [...md.matchAll(/^```mermaid[ \t]*\n([\s\S]*?)^```[ \t]*$/gm)].map((m) => m[1]);

/** Files git tracks; null when git is unavailable (a source tarball). */
function trackedFiles() {
  try {
    return new Set(execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

test('docs helpers: images, links, anchors and Mermaid blocks are read the way GitHub renders them', () => {
  const md = [
    '# Title',
    '[![CI](https://x.test/b.svg)](https://x.test) ![card](public/a.png "t") <img alt="x" src="brand/b.svg">',
    '## 5.3 `request_claim` (disc 2)',
    '## Licence',
    '## Licence',
    '```bash',
    '![not an image](nope.png) [not a link](nope.md)',
    '# not a heading',
    '```',
    '```mermaid',
    'sequenceDiagram',
    '```',
  ].join('\n');
  assert.deepEqual(images(md), ['https://x.test/b.svg', 'public/a.png', 'brand/b.svg']);
  assert.deepEqual(links(md), ['https://x.test/b.svg', 'https://x.test', 'public/a.png']);
  assert.deepEqual([...anchors(md)], ['title', '53-request_claim-disc-2', 'licence', 'licence-1']);
  assert.deepEqual(mermaidBlocks(md), ['sequenceDiagram\n']);
  assert.ok(anchors(SPEC).has('1-invariants-what-reviewers-must-be-able-to-confirm'));
});

test('README: every workflow badge names a workflow in .github/workflows and links to it', () => {
  const badges = [...README.matchAll(/\[!\[[^\]]*\]\(([^)\s]*\/actions\/workflows\/([^/)\s]+)\/badge\.svg[^)\s]*)\)\]\(([^)\s]+)\)/g)];
  assert.ok(badges.length >= 1, 'the CI badge');
  // every badge.svg in the file is one of the linked badges above (none hides in other markup)
  assert.equal(badges.length, README.match(/\/badge\.svg/g).length);
  for (const [, src, file, href] of badges) {
    assert.ok(existsSync(join(ROOT, '.github', 'workflows', file)), `${src}: .github/workflows/${file} does not exist`);
    assert.ok(src.startsWith(`${REPO}/actions/workflows/${file}/badge.svg`), `${src}: a badge of another repository`);
    assert.equal(href, `${REPO}/actions/workflows/${file}`, `${src}: the badge links to its workflow`);
  }
});

test('README: every image is a tracked file, a workflow badge of this repository or a static shields.io badge', (t) => {
  const tracked = trackedFiles();
  if (!tracked) return t.skip('git is not available');
  const srcs = images(README);
  assert.ok(srcs.includes('public/og.png'), 'the product card');
  for (const src of srcs) {
    if (/^[a-z]+:/i.test(src)) {
      assert.ok(src.startsWith(`${REPO}/actions/workflows/`) || src.startsWith('https://img.shields.io/badge/'), `${src}: images are repository files; only badges load from elsewhere`);
      continue;
    }
    const path = normalize(decodeURIComponent(src.replace(/[?#].*$/, ''))).replace(/^\.\//, '');
    assert.ok(tracked.has(path), `${src} is not a tracked file`);
  }
});

test('README: relative links reach a file or folder, and every #anchor a heading', () => {
  let checked = 0;
  for (const target of links(README)) {
    if (/^[a-z]+:/i.test(target)) continue;
    const [rawPath, anchor] = target.split('#');
    const path = rawPath ? normalize(decodeURIComponent(rawPath)) : 'README.md';
    assert.ok(existsSync(join(ROOT, path)), `${target}: ${path} does not exist`);
    if (anchor !== undefined) {
      assert.ok(/\.md$/.test(path), `${target}: an anchor into a file that is not Markdown`);
      assert.ok(anchors(read(path)).has(decodeURIComponent(anchor)), `${target}: ${path} has no heading #${anchor}`);
    }
    checked++;
  }
  assert.ok(checked >= 10, `${checked} relative links`);
  assert.ok(links(README).includes('#licence'), 'the licence badge links to the Licence section');
});

test('README: the product card links to the live site and the explorer link is the mainnet program', () => {
  assert.equal(ORIGINS.mainnet, 'https://atlaspad.online');
  assert.match(README, /^\[!\[[^\]]+\]\(public\/og\.png\)\]\(https:\/\/atlaspad\.online\)$/m);
  const deployed = JSON.parse(read('deploy/mainnet.json')).programId;
  assert.equal(deployed, PROGRAM_ID);
  const explorer = [...README.matchAll(/https:\/\/explorer\.solana\.com\/address\/([^)\s]+)/g)].map((m) => m[1]);
  assert.ok(explorer.length >= 1, 'a link to the program on the explorer');
  for (const address of explorer) assert.equal(address, deployed, 'a mainnet explorer link (no ?cluster=) to the deployed program');
});

test('README: the official token section shows exactly the address the site shows (src/config.ts OFFICIAL_TOKEN_MINT)', () => {
  const site = /export const OFFICIAL_TOKEN_MINT = '([1-9A-HJ-NP-Za-km-z]+)';/.exec(read('src/config.ts'))?.[1];
  assert.ok(site, 'src/config.ts declares OFFICIAL_TOKEN_MINT as a base58 string');
  // a Solana address: base58 that decodes to exactly 32 bytes
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of site) n = n * 58n + BigInt(ALPHA.indexOf(c));
  let bytes = 0;
  for (let x = n; x > 0n; x >>= 8n) bytes++;
  bytes += site.match(/^1*/)[0].length;
  assert.equal(bytes, 32, `${site} is not a 32-byte Solana address`);
  const section = README.split(/^## /m).find((s) => s.startsWith('Official token\n'));
  assert.ok(section, 'README has an "Official token" section');
  const shown = [...section.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,44}/g)].map((m) => m[0]);
  assert.ok(shown.length >= 2, 'the address in a code block and in the pump.fun link');
  for (const a of shown) assert.equal(a, site, 'every address in the section is the official one');
  assert.ok(section.includes(`https://pump.fun/coin/${site}`), 'the pump.fun link points at the official mint');
});

test('README: the "How it works" diagram names only instructions SPEC.md specifies (shop_vault:: with a §5 heading, pump:: by name)', () => {
  const blocks = mermaidBlocks(README);
  assert.equal(blocks.length, 1, 'one Mermaid block');
  const [diagram] = blocks;
  assert.match(diagram, /^sequenceDiagram$/m);
  const section = README.split(/^## /m).find((s) => s.startsWith('How it works\n'));
  assert.ok(section?.includes('```mermaid\n'), 'the diagram is in "## How it works"');
  // every instruction is labelled with its program: shop_vault:: ours, pump:: (or pump_amm::) pump.fun's
  const named = [...diagram.matchAll(/(?<![\w:])(\w+)::(\w+)/g)].map(([, program, name]) => ({ program, name }));
  assert.deepEqual([...new Set(named.map((n) => n.program))].filter((p) => !['shop_vault', 'pump', 'pump_amm'].includes(p)), []);
  const instructions = new Set([...SPEC.matchAll(/^### 5\.\d+ `(\w+)` \(disc \d+\)$/gm)].map((m) => m[1]));
  assert.ok(instructions.has('withdraw') && instructions.size >= 7, `SPEC §5 instruction headings: ${[...instructions]}`);
  const ours = named.filter((n) => n.program === 'shop_vault').map((n) => n.name);
  assert.ok(ours.length >= 4, ours.join(', '));
  for (const name of ours) assert.ok(instructions.has(name), `shop_vault::${name} has no "### 5.x \`${name}\` (disc n)" heading in ${SPEC_PATH}`);
  const theirs = named.filter((n) => n.program !== 'shop_vault');
  assert.ok(theirs.length >= 1);
  for (const { program, name } of theirs) assert.ok(SPEC.includes(`${program}::${name}`), `${program}::${name} does not appear in ${SPEC_PATH}`);
  // the claim window is the mainnet one, and the diagram says who may cancel in it
  assert.equal(JSON.parse(read('deploy/mainnet.json')).claimWindowSecs, 72 * 3600);
  assert.match(diagram, /72 h window/);
  assert.match(diagram, /guardian \(or governance\) may cancel/);
});
