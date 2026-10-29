/**
 * Minimal Node typings for worker unit tests (the worker tsconfig only loads @cloudflare/workers-types).
 * Tests run under vitest in Node; production Worker code must never import these modules.
 */
declare module 'node:module' {
  export function createRequire(path: string): (id: string) => any;
}
declare module 'node:sqlite' {
  export interface StatementSync {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    columns(): { name: string }[];
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
}
interface ImportMeta {
  readonly url: string;
}
