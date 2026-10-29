/** Mainnet build constants for unit tests (no dev endpoints compiled in). Import FIRST. */
const g = globalThis as unknown as { __CS_CLUSTER__?: string; __CS_DEV_ENDPOINTS__?: boolean };
g.__CS_CLUSTER__ = 'mainnet';
g.__CS_DEV_ENDPOINTS__ = false;
export {};
