/**
 * MUST be the first import of src/chain/index.ts (and src/dev/index.ts): web3.js, Anchor (pump SDK) and spl-token
 * expect a global `Buffer` in the browser. Side-effect only.
 */
import { Buffer } from 'buffer';

const g = globalThis as unknown as { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;
