// A workflow step's shell script, run under bash as GitHub Actions would: shared by ops.test.mjs and release.test.mjs.
// Not a test file itself (`node --test scripts/test/*.test.mjs` does not pick it up).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/** The `run: |` script of the workflow step named `name` (dedented), for running it under bash as Actions would. */
export function stepScript(yml, name) {
  const lines = yml.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `no step "${name}"`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
  const indent = lines[runAt].search(/\S/);
  const body = [];
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() && l.search(/\S/) <= indent) break;
    body.push(l);
  }
  const pad = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(pad)).join('\n');
}

/** Runs a step script in `cwd` with GitHub's shell flags and nothing but `env` (PATH too): its exit code and output. */
export function runBash(script, cwd, env) {
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd, env, encoding: 'utf8' });
  return { code: r.status, text: r.stdout + r.stderr };
}
