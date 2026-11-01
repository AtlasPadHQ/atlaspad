// node --test scripts/test/   (GitHub Releases: the CHANGELOG.md parser behind release.yml, the workflow's own steps
// run under bash with a stand-in `gh`, and the version that package.json, package-lock.json and CHANGELOG.md share).
// Repository files and fabricated fixtures only: no network, no real gh.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { CHANGELOG, changelogEntries, newestVersion, releaseBody, releaseNotes } from '../lib/changelog.mjs';
import { ROOT } from '../lib/paths.mjs';
import { runBash, stepScript } from './workflow-step.mjs';

const TEXT = readFileSync(CHANGELOG, 'utf8');
const RELEASE_YML = () => readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
const json = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));

test('release notes: v0.7.0 is titled by its heading and stops before the v0.6.2 entry', () => {
  const { title, body } = releaseNotes(TEXT, 'v0.7.0');
  assert.equal(title, 'v0.7.0 — first public release');
  assert.match(body, /^AtlasPad is open source: https:\/\/github\.com\/AtlasPadHQ\/atlaspad\. /);
  assert.match(body, /- Tests use fictional places instead of real businesses\.$/);
  assert.ok(!body.includes('## v0.6.2') && !body.includes('x.com/AtlasPadx'), 'nothing of v0.6.2');
  assert.equal(releaseNotes(TEXT, 'v0.6.0').title, 'v0.6.0 — AtlasPad is live on Solana mainnet');
});

test('release notes: a heading without " · title" (v0.6.2) is titled by its date', () => {
  const { title, body } = releaseNotes(TEXT, 'v0.6.2');
  assert.equal(title, 'v0.6.2 — 2026-10-29');
  assert.match(body, /^- AtlasPad's X account/);
  // the X handle must not mention (and notify) a GitHub account of that name
  assert.ok(!/(^|[^`])@AtlasPadx/m.test(body), body);
  assert.match(body, /`@AtlasPadx`/);
});

test('CHANGELOG.md: every "## v" heading parses, versions only go down, an unknown tag throws', () => {
  const entries = changelogEntries(TEXT);
  assert.equal(entries.length, TEXT.match(/^## /gm).length);
  assert.ok(entries.length >= 25, `${entries.length} entries`);
  const num = (v) => v.split('.').map(Number);
  for (let i = 1; i < entries.length; i++) {
    const [a, b] = [num(entries[i - 1].version), num(entries[i].version)];
    const newer = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    assert.ok(newer > 0, `${entries[i - 1].tag} must be newer than the ${entries[i].tag} below it`);
    assert.ok(entries[i - 1].date >= entries[i].date, `${entries[i - 1].tag} is dated before ${entries[i].tag}`);
  }
  for (const e of entries) assert.ok(releaseNotes(TEXT, e.tag).body, `${e.tag} has notes`);
  assert.throws(() => releaseNotes(TEXT, 'v9.9.9'), /CHANGELOG\.md has no entry for v9\.9\.9/);
  for (const bad of ['0.7.0', 'v0.7', 'v0.7.0-rc.1', 'v0.7.0\n', '']) assert.throws(() => releaseNotes(TEXT, bad), /not a version tag/, JSON.stringify(bad));
  assert.throws(() => changelogEntries('# Changelog\n\n## v0.7 — 2026-11-01\n- x\n'), /CHANGELOG\.md:3: expected/);
  assert.throws(() => changelogEntries('## v0.7.1 - 2026-11-01\n'), /CHANGELOG\.md:1: expected/, 'a hyphen is not the em dash');
});

test('release body: wrapped lines are joined; lists, labels, headings and code blocks keep their lines', () => {
  const md = [
    'A paragraph wrapped',
    'at 120 columns.',
    '',
    'Label',
    '- an item that',
    '  goes on, `@kept` in code',
    '  - a nested item',
    '1. ordered',
    '### Sub',
    'text under it by @someone and (@else), mail hello@atlaspad.online, checkout@v5',
    '```bash',
    'node a.mjs',
    '  --flag @x',
    '```',
    'after the fence',
  ].join('\n');
  assert.equal(
    releaseBody(md),
    [
      'A paragraph wrapped at 120 columns.',
      '',
      'Label',
      '- an item that goes on, `@kept` in code',
      '  - a nested item',
      '1. ordered',
      '### Sub',
      'text under it by `@someone` and (`@else`), mail hello@atlaspad.online, checkout@v5',
      '```bash',
      'node a.mjs',
      '  --flag @x',
      '```',
      'after the fence',
    ].join('\n'),
  );
});

test('versions: package.json, both package-lock.json root versions and the newest CHANGELOG heading agree', () => {
  const v = newestVersion(TEXT);
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.match(TEXT, new RegExp(`^## v${v.replaceAll('.', '\\.')} — \\d{4}-\\d{2}-\\d{2}(?: · .+)?$`, 'm'));
  const pkg = json('package.json');
  const lock = json('package-lock.json');
  assert.deepEqual({ pkg: pkg.version, lock: lock.version, lockRoot: lock.packages[''].version }, { pkg: v, lock: v, lockRoot: v }, 'a release commit bumps all three by hand');
});

// ---- .github/workflows/release.yml ----------------------------------------------------------------------------------

/**
 * Runs a step script (workflow-step.mjs) from the repository root with a stand-in `gh` first on PATH. The stand-in
 * records each call (arguments split by tabs), answers `gh release view <tag>` with exit code GH_VIEW (1: no Release
 * yet), and answers `gh release view --json tagName` (the repo's Latest) with GH_LATEST (empty: no Release at all).
 */
function runStep(script, env) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-release-'));
  mkdirSync(join(dir, 'bin'));
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'bin', 'gh'), String.raw`#!/usr/bin/env bash
(IFS=$'\t'; printf '%s\n' "$*") >> "$GH_LOG"
if [ "$1 $2 $3" = "release view --json" ]; then
  [ -n "$GH_LATEST" ] || { echo 'release not found' >&2; exit 1; }
  printf '%s\n' "$GH_LATEST"
  exit 0
fi
[ "$1 $2" != "release view" ] || exit "$GH_VIEW"
`);
  chmodSync(join(dir, 'bin', 'gh'), 0o755);
  const PATH = [join(dir, 'bin'), dirname(process.execPath), process.env.PATH].join(':');
  const r = runBash(script, ROOT, { PATH, RUNNER_TEMP: dir, GH_LOG: log, GH_VIEW: '1', GH_LATEST: '', ...env });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
  return { ...r, calls, notes: join(dir, 'notes.md') };
}

test('release.yml: tag pushes and dispatches; read-only token except the job; GITHUB_TOKEN only; the tag only via env', () => {
  const yml = RELEASE_YML();
  assert.match(yml, /^on:\n {2}push:\n {4}tags: \['v\*\.\*\.\*'\]\n {2}workflow_dispatch:\n {4}inputs:\n {6}tag:\n/m);
  assert.match(yml, /^permissions:\n {2}contents: read$/m);
  // one run at a time across all tags, so each run reads the Latest that the run before it left
  assert.match(yml, /^concurrency:\n {2}group: release\n {2}cancel-in-progress: false$/m);
  assert.match(yml, /^ {4}permissions:\n {6}contents: write$/m, 'write on the job only');
  assert.equal(yml.match(/: write$/gm).length, 1);
  assert.match(yml, /^ {6}TAG: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}$/m);
  assert.match(yml, /^ {6}GH_TOKEN: \$\{\{ github\.token \}\}$/m);
  // github-actions[bot] publishes: no personal token, no secret of any kind
  assert.ok(!/secrets\.|GH_PAT|PERSONAL/i.test(yml));
  // the tag is checked before the checkout, and no shell script interpolates an expression
  assert.ok(yml.indexOf('- name: Version tag') < yml.indexOf('uses: actions/checkout@'));
  assert.equal(yml.match(/^\s+run: /gm).length, 2);
  for (const name of ['Version tag', 'Publish the Release']) assert.ok(!stepScript(yml, name).includes('${{'), name);
});

test('release.yml "Version tag": only an exact vX.Y.Z goes on', () => {
  const check = stepScript(RELEASE_YML(), 'Version tag');
  for (const TAG of ['v0.7.1', 'v10.20.300']) assert.equal(runStep(check, { TAG }).code, 0, TAG);
  for (const TAG of ['', '0.7.1', 'v0.7', 'v0.7.1-rc.1', 'v0.7.1 ', 'v0.7.1\nv0.7.2', 'v0.7.1;id', '$(id)', 'main']) {
    const r = runStep(check, { TAG });
    assert.equal(r.code, 1, JSON.stringify(TAG));
    assert.match(r.text, /::error::the tag must be vX\.Y\.Z/);
  }
});

test('release.yml "Publish the Release": creates from the CHANGELOG, edits on a rerun', () => {
  const publish = stepScript(RELEASE_YML(), 'Publish the Release');
  const newest = `v${newestVersion(TEXT)}`;
  const LATEST = ['release', 'view', '--json', 'tagName', '--jq', '.tagName'];

  // a tag with no Release yet (none at all): created from the pushed tag, with the entry's title and notes
  let r = runStep(publish, { TAG: newest });
  assert.equal(r.code, 0, r.text);
  const { title, body } = releaseNotes(TEXT, newest);
  assert.deepEqual(r.calls, [
    LATEST,
    ['release', 'view', newest],
    ['release', 'create', newest, '--verify-tag', '--title', title, '--notes-file', r.notes, '--latest=true'],
  ]);
  assert.equal(readFileSync(r.notes, 'utf8'), `${body}\n`);

  // a rerun: the Release exists (and is Latest), so it is edited instead of failing
  r = runStep(publish, { TAG: newest, GH_VIEW: '0', GH_LATEST: newest });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.calls, [LATEST, ['release', 'view', newest], ['release', 'edit', newest, '--title', title, '--notes-file', r.notes, '--latest=true']]);

  // the v0.7.0 backfill (run on main once a newer Release is Latest): created, but not Latest
  r = runStep(publish, { TAG: 'v0.7.0', GH_LATEST: newest });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.calls.at(-1), ['release', 'create', 'v0.7.0', '--verify-tag', '--title', 'v0.7.0 — first public release', '--notes-file', r.notes, '--latest=false']);

  // a tag without an entry fails before gh is called
  r = runStep(publish, { TAG: 'v9.9.9' });
  assert.notEqual(r.code, 0);
  assert.match(r.text, /no entry for v9\.9\.9/);
  assert.deepEqual(r.calls, []);
});

test('release.yml "Publish the Release": the Latest on GitHub decides "Latest", not the checked-out CHANGELOG', () => {
  const publish = stepScript(RELEASE_YML(), 'Publish the Release');
  const newest = `v${newestVersion(TEXT)}`;
  /** The --latest flag the step passes for TAG when GitHub's Latest is GH_LATEST ('' = no Release yet). */
  const latest = (TAG, GH_LATEST, { exists = false } = {}) => {
    const r = runStep(publish, { TAG, GH_LATEST, GH_VIEW: exists ? '0' : '1' });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.calls.at(-1)[1], exists ? 'edit' : 'create');
    return r.calls.at(-1).at(-1);
  };

  // no Release yet, or the Latest is older: this tag takes it
  assert.equal(latest(newest, ''), '--latest=true');
  assert.equal(latest(newest, 'v0.7.0'), '--latest=true');
  // the newest tag's own rerun keeps it
  assert.equal(latest(newest, newest, { exists: true }), '--latest=true');
  // the v0.7.0 backfill while a newer Release is Latest never takes it over
  assert.equal(latest('v0.7.0', newest), '--latest=false');
  // a tag pushed after a newer version's Release (one tagged only once it is deployed), or its run re-run later: the
  // tag's own tree has it as the newest CHANGELOG entry, but the newer Release stays Latest. Versions compare by number
  // (v0.10.0 is newer than v0.9.0, though not as text).
  for (const newer of ['v99.0.0', 'v0.10.0']) {
    assert.equal(latest(newest, newer), '--latest=false', newer);
    assert.equal(latest(newest, newer, { exists: true }), '--latest=false', newer);
  }
  assert.equal(latest('v0.6.2', 'v0.6.10'), '--latest=false');
});
