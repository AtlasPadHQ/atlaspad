#!/usr/bin/env node
/**
 * Writes `.dev.vars.devnet` for `wrangler dev --env devnet` (INTEGRATION §1.10).
 *
 *   node scripts/dev-vars.mjs devnet
 *
 * Contents: the §1.6 devnet secret set (from .env.server and .keys/), plus ALT_ADDRESS from deploy/devnet.json and
 * BUILD_ID=local. The file is created with mode 600 and must be gitignored (`.dev.vars*`); the script refuses
 * otherwise. Prints NAMES only, never values. Devnet only: a mainnet secret file is never written to disk.
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDeploy } from './lib/deployJson.mjs';
import { bad, fatal, head, info, ok, warn } from './lib/log.mjs';
import { ROOT } from './lib/paths.mjs';
import { collectSecrets } from './lib/secretPut.mjs';

/** Serialises KEY=VALUE lines; values are quoted only when needed (wrangler reads dotenv syntax). */
export function devVarsText(map) {
  return (
    Object.entries(map)
      .map(([k, v]) => {
        if (/[\r\n]/.test(v)) throw new Error(`${k}: value contains a newline`);
        return /^[A-Za-z0-9_+/=.:-]*$/.test(v) ? `${k}=${v}` : `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      })
      .join('\n') + '\n'
  );
}

export function gitignoreCovers(name, gitignoreText) {
  return gitignoreText.split(/\r?\n/).some((l) => {
    const t = l.trim();
    if (!t || t.startsWith('#') || t.startsWith('!')) return false;
    if (t === name) return true;
    const re = new RegExp(`^${t.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return re.test(name);
  });
}

async function main() {
  const env = process.argv[2];
  if (env !== 'devnet') fatal('usage: node scripts/dev-vars.mjs devnet  (mainnet secrets are never written to disk)', 64);
  head('dev-vars · devnet');
  const file = `.dev.vars.${env}`;
  const gi = existsSync(join(ROOT, '.gitignore')) ? readFileSync(join(ROOT, '.gitignore'), 'utf8') : '';
  if (!gitignoreCovers(file, gi)) fatal(`.gitignore does not cover ${file}; refusing to write secrets there`);

  const { values, missingRequired, missingOptional } = collectSecrets(env);
  for (const n of missingRequired) bad(`missing required source for ${n} (see RUNBOOK "Keys and secrets")`);
  for (const n of missingOptional) info(`optional ${n} not set`);
  if (missingRequired.length) fatal('not writing an incomplete file');

  const dep = readDeploy(env);
  const vars = { ...values, BUILD_ID: 'local' };
  if (dep?.alt) vars.ALT_ADDRESS = dep.alt;
  else warn('deploy/devnet.json has no ALT yet (run scripts/create-alt.mjs); ALT_ADDRESS left unset');

  const path = join(ROOT, file);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, devVarsText(vars), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  ok(`wrote ${file} (mode 600): ${Object.keys(vars).join(', ')}`);
  info('run: npx wrangler d1 migrations apply cornershop-devnet --env devnet --local && npm run worker:devnet');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fatal(e.message));
}
