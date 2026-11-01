/**
 * CHANGELOG.md: one `## ` section per version tag, newest first, headed `## vX.Y.Z — YYYY-MM-DD` with an optional
 * ` · title`. A tag's section is its GitHub Release (scripts/release-notes.mjs, .github/workflows/release.yml), and the
 * newest heading is the version in package.json and package-lock.json (scripts/test/release.test.mjs).
 */
import { join } from 'node:path';
import { ROOT } from './paths.mjs';

export const CHANGELOG = join(ROOT, 'CHANGELOG.md');
export const VERSION_TAG = /^v\d+\.\d+\.\d+$/;
const HEADING = /^## v(\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})(?: · (.+))?$/;

/**
 * Every section, newest first: {tag, version, date, title (null without ` · title`), body}. A body runs to the next
 * `## ` heading (`###` stays inside). A `## ` heading of any other shape throws.
 */
export function changelogEntries(text) {
  const entries = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.startsWith('## ')) return void entries.at(-1)?.lines.push(line);
    const m = HEADING.exec(line);
    if (!m) throw new Error(`CHANGELOG.md:${i + 1}: expected "## vX.Y.Z — YYYY-MM-DD" (optionally " · title"), got ${JSON.stringify(line)}`);
    entries.push({ tag: `v${m[1]}`, version: m[1], date: m[2], title: m[3] ?? null, lines: [] });
  });
  return entries.map(({ lines, ...e }) => ({ ...e, body: lines.join('\n').trim() }));
}

/** The newest entry's version (x.y.z): package.json's version must equal it. */
export function newestVersion(text) {
  const [newest] = changelogEntries(text);
  if (!newest) throw new Error('CHANGELOG.md has no "## vX.Y.Z — YYYY-MM-DD" entry');
  return newest.version;
}

/** The GitHub Release of `tag`: title `<tag> — <title>`, or `<tag> — <date>` when the heading has none, and its notes. */
export function releaseNotes(text, tag) {
  if (!VERSION_TAG.test(String(tag))) throw new Error(`not a version tag: ${JSON.stringify(tag)} (vX.Y.Z)`);
  const entry = changelogEntries(text).find((e) => e.tag === tag);
  if (!entry) throw new Error(`CHANGELOG.md has no entry for ${tag}`);
  return { title: `${tag} — ${entry.title ?? entry.date}`, body: releaseBody(entry.body) };
}

// a line that opens a Markdown block (list item, heading, quote, table row, code fence) is never joined to the one above
const BLOCK_START = /^\s*(?:[-*+] |\d+[.)] |#|>|\||```|~~~)/;
const FENCE = /^\s*(?:```|~~~)/;
// a line the next one never joins: a heading, a table row, a fence, or one ending in a Markdown hard break
const BLOCK_END = /^\s*(?:#|\||```|~~~)|(?: {2}|\\)$/;

/**
 * CHANGELOG.md is wrapped at 120 columns, and GitHub shows every newline of a Release as a line break: a paragraph's or
 * list item's continuation lines are joined to it (code blocks stay as they are). A bare `@name` would mention, link and
 * notify a GitHub account (an X handle, say), so it goes in a code span.
 */
export function releaseBody(md) {
  const joined = [];
  let code = false;
  for (const line of md.split('\n')) {
    const prev = joined.at(-1);
    if (!code && line.trim() && prev?.trim() && !BLOCK_START.test(line) && !BLOCK_END.test(prev)) joined[joined.length - 1] = `${prev} ${line.trim()}`;
    else joined.push(line);
    if (FENCE.test(line)) code = !code;
  }
  code = false;
  return joined
    .map((line) => {
      const fence = FENCE.test(line);
      if (fence) code = !code;
      return code || fence ? line : codeSpanMentions(line);
    })
    .join('\n');
}

/** `@name` → `` `@name` `` outside code spans (an email address or `action@v5` has a word character before the @). */
function codeSpanMentions(line) {
  return line
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/(^|[\s(["'])@([A-Za-z0-9][A-Za-z0-9-]*)/g, '$1`@$2`')))
    .join('');
}
