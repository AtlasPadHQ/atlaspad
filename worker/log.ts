/**
 * Structured logs (one JSON object per line, Workers Logs). NEVER log a URL or fetch init that holds a key, a phone
 * number, a code, a token or an IP (INTEGRATION H2, §1.4). As a last guard every line is scrubbed: any secret value of
 * this Worker is replaced by "[redacted]", and Alchemy URL paths are cut.
 */
import { devSecretValues, SECRET_NAMES, type Env } from './env';

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Fields = Record<string, string | number | boolean | null | undefined | string[]>;

export interface Logger {
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
}

const ALCHEMY_PATH = /(g\.alchemy\.com)\/v2\/[^\s"'\\]*/gi;

export function scrubber(env: Env | undefined): (s: string) => string {
  const secrets: string[] = [];
  if (env) {
    for (const k of SECRET_NAMES) {
      const v = env[k];
      if (typeof v === 'string' && v.trim().length >= 6) secrets.push(v.trim());
    }
    let dev: string[] = [];
    try {
      dev = devSecretValues(env);
    } catch {
      dev = []; // unit tests without the compile-time define
    }
    for (const v of dev) if (v.trim().length >= 6) secrets.push(v.trim());
  }
  return (s: string) => {
    let out = s.replace(ALCHEMY_PATH, '$1/v2/[redacted]');
    for (const v of secrets) if (out.includes(v)) out = out.split(v).join('[redacted]');
    return out;
  };
}

export function makeLogger(env: Env | undefined, base: Fields = {}): Logger {
  const scrub = scrubber(env);
  const emit = (level: Level, event: string, fields?: Fields) => {
    let line: string;
    try {
      line = JSON.stringify({ level, event, ...base, ...fields });
    } catch {
      line = JSON.stringify({ level, event, note: 'unserializable fields' });
    }
    line = scrub(line);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  };
}

/** Error message without stack, safe to log (still scrubbed by the logger). */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message.slice(0, 300);
  return String(e).slice(0, 300);
}
