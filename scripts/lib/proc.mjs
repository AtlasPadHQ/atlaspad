/**
 * Child processes with redacted, line-buffered output (CLI output can echo URLs or, on a failed keypair write, a seed
 * phrase; every line goes through log.redact(), which also drops seed-phrase lines). stdin is closed.
 */
import { spawn } from 'node:child_process';
import { redact } from './log.mjs';
import { ROOT, toolEnv } from './paths.mjs';

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string,string>, echo?: boolean, prefix?: string, timeoutMs?: number }} [o]
 * @returns {Promise<{ code: number, out: string }>} out = redacted combined output
 */
export function run(cmd, args, o = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd ?? ROOT, env: toolEnv(o.env ?? {}), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let pending = '';
    const timer = o.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), o.timeoutMs) : null;
    const onData = (d) => {
      pending += String(d);
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const l of lines) {
        const r = redact(l);
        if (!r && l) continue; // dropped (seed-phrase line)
        out += `${r}\n`;
        if (o.echo !== false) console.log(`${o.prefix ?? '    '}${r}`);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (pending) onData('\n');
      resolve({ code: code ?? 1, out });
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, out: redact(String(e.message)) });
    });
  });
}

/** True when `cmd --version` runs. */
export async function hasCommand(cmd) {
  const r = await run(cmd, ['--version'], { echo: false, timeoutMs: 20_000 });
  return r.code === 0;
}
