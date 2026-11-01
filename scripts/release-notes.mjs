#!/usr/bin/env node
/**
 * A version tag's GitHub Release, from its CHANGELOG.md entry (scripts/lib/changelog.mjs). .github/workflows/release.yml
 * runs it for every tag; it reads only CHANGELOG.md, so it needs no npm install.
 *
 *   node scripts/release-notes.mjs v0.7.1            # the notes (Markdown) on stdout
 *   node scripts/release-notes.mjs --title v0.7.1    # the title: "v0.7.1 — <heading title>", else "v0.7.1 — <date>"
 */
import { readFileSync } from 'node:fs';
import { CHANGELOG, releaseNotes } from './lib/changelog.mjs';
import { fatal, parseArgs } from './lib/log.mjs';

function main() {
  const args = parseArgs(process.argv.slice(2), ['title']);
  const [tag] = args._;
  if (!tag) fatal('usage: node scripts/release-notes.mjs [--title] vX.Y.Z', 64);
  const { title, body } = releaseNotes(readFileSync(CHANGELOG, 'utf8'), tag);
  console.log(args.title ? title : body);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    fatal(e.message);
  }
}
