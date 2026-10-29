/**
 * Solana wallets via the Wallet Standard (@wallet-standard/app getWallets()), plus legacy
 * window.phantom.solana / window.solflare / window.backpack fallbacks, plus the mocked
 * "Continue with email" embedded wallet (DESIGN §12.4).
 *
 * SAFETY:
 *  - DEMO mode (Phase 1, `?mode=demo` or a demo-only build): ONLY `standard:connect`, `standard:disconnect` and
 *    `standard:events` are ever touched (legacy providers: connect / disconnect / on). Nothing can request a
 *    signature or send a transaction: `getSigner()` calls `assertRealMode()` first and throws in demo mode.
 *  - REAL mode (INTEGRATION.md §4.9): `getSigner()` wraps the connected Wallet Standard wallet's
 *    `solana:signTransaction` (and `solana:signMessage` when present). It is the ONLY place a signing feature is
 *    read. It never calls `solana:signAndSendTransaction`: the chain layer sends through `/api/rpc` itself after
 *    checking that the wallet did not change the co-signed message (SPEC §8.4). Legacy injected providers and the
 *    mocked email wallet get no signer (→ `wallet-unsupported`).
 *
 * Contract (CONTRACTS.md §2):
 *   listWallets(): WalletInfo[]
 *   connectWallet(name): Promise<{ address; walletName; icon? }>
 *   disconnect(): Promise<void>
 *   createEmailWallet(email): { address }
 *   getSigner(): WalletSigner | null           (real mode only; INTEGRATION.md §4.9)
 * Extras used by src/wallet UI: subscribeWallets, waitForWallet, onActiveAccountChange,
 * WalletConnectError, walletErrorMessage, maskEmail, isEmailLike.
 */
import { getWallets, type Wallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type { WalletSigner } from '../chain/types';
import { PINNED_WALLETS, links } from '../config';
import { CLUSTER, IS_REAL, assertRealMode } from '../mode';
import { fakeWallet, isValidSolanaAddress } from '../lib/fakeSolana';
import { isMobileNow } from '../lib/media';
import type { WalletInfo } from '../types';

/* ------------------------------------------------------------------ feature shapes */

const CONNECT = 'standard:connect';
const DISCONNECT = 'standard:disconnect';
const EVENTS = 'standard:events';
/** Real mode only (read exclusively inside getSigner). */
const SIGN_TRANSACTION = 'solana:signTransaction';
const SIGN_MESSAGE = 'solana:signMessage';
/**
 * Name of the devnet test wallet (src/dev), pinned first on devnet. Inline compile-time guard: the string is dead code
 * (removed) in every non-devnet-test build, so scripts/check-bundle.mjs finds no "Devnet Test Wallet" in mainnet.
 */
const TEST_WALLET_NAME: string | null =
  import.meta.env.VITE_TEST_WALLET === '1' && import.meta.env.VITE_CLUSTER === 'devnet' ? 'Devnet Test Wallet' : null;

interface ConnectFeature {
  version: string;
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }>;
}
interface DisconnectFeature {
  version: string;
  disconnect(): Promise<void>;
}
interface EventsFeature {
  version: string;
  on(event: 'change', listener: (props: { accounts?: readonly WalletAccount[] }) => void): () => void;
}

interface SignTransactionFeature {
  version: string;
  supportedTransactionVersions?: readonly ('legacy' | 0 | 1)[];
  signTransaction(
    ...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: `${string}:${string}` }[]
  ): Promise<readonly { signedTransaction: Uint8Array }[]>;
}
interface SignMessageFeature {
  version: string;
  signMessage(...inputs: { account: WalletAccount; message: Uint8Array }[]): Promise<readonly { signedMessage: Uint8Array; signature: Uint8Array }[]>;
}

/** Pre-standard injected providers (Phantom / Solflare / Backpack). Only connect/disconnect/on are used. */
interface LegacyProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<unknown>;
  disconnect?(): Promise<void>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
  off?(event: string, cb: (...args: unknown[]) => void): void;
  removeListener?(event: string, cb: (...args: unknown[]) => void): void;
}

interface LegacyWindow {
  phantom?: { solana?: LegacyProvider };
  solflare?: LegacyProvider;
  backpack?: LegacyProvider;
}

/* ------------------------------------------------------------------ errors */

export type WalletErrorCode = 'rejected' | 'timeout' | 'not-found' | 'no-account' | 'error';

export class WalletConnectError extends Error {
  constructor(
    public readonly code: WalletErrorCode,
    public readonly walletName: string,
    message?: string,
  ) {
    super(message ?? `${walletName}: ${code}`);
    this.name = 'WalletConnectError';
  }
}

/** Inline row error copy (DESIGN §16.12). */
export function walletErrorMessage(err: unknown, walletName: string): string {
  const code = err instanceof WalletConnectError ? err.code : 'error';
  if (code === 'rejected') return `Request cancelled in ${walletName}`;
  if (code === 'no-account') return `${walletName} didn't share a Solana account. Try again.`;
  return `${walletName} isn't responding. Try again.`;
}

function classify(err: unknown, walletName: string): WalletConnectError {
  if (err instanceof WalletConnectError) return err;
  const e = (err ?? {}) as { code?: number | string; name?: string; message?: string };
  const msg = String(e.message ?? '').toLowerCase();
  if (e.code === 4001 || e.name === 'UserRejectedRequestError' || /reject|cancel|denied|declined|closed|abort/.test(msg)) {
    return new WalletConnectError('rejected', walletName, e.message);
  }
  return new WalletConnectError('error', walletName, e.message);
}

function withTimeout<T>(p: Promise<T>, ms: number, walletName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new WalletConnectError('timeout', walletName)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

/* ------------------------------------------------------------------ discovery */

let api: Wallets | null = null;

/** Lazily initialise the Wallet Standard registry (dispatches the app-ready event once). */
function registry(): Wallets | null {
  if (typeof window === 'undefined') return null;
  if (!api) {
    try {
      api = getWallets();
    } catch {
      api = null;
    }
  }
  return api;
}

const norm = (s: string) => s.trim().toLowerCase();

function isSolanaStandard(w: Wallet): boolean {
  return CONNECT in w.features && w.chains.some((c) => c.startsWith('solana:'));
}

function standardWallets(): Wallet[] {
  const r = registry();
  if (!r) return [];
  try {
    return r.get().filter(isSolanaStandard);
  } catch {
    return [];
  }
}

function legacyProviders(): { name: string; provider: LegacyProvider }[] {
  if (typeof window === 'undefined') return [];
  const w = window as unknown as LegacyWindow;
  const out: { name: string; provider: LegacyProvider }[] = [];
  try {
    const phantom = w.phantom?.solana;
    if (phantom?.isPhantom && typeof phantom.connect === 'function') out.push({ name: 'Phantom', provider: phantom });
    const solflare = w.solflare;
    if (solflare && typeof solflare.connect === 'function') out.push({ name: 'Solflare', provider: solflare });
    const backpack = w.backpack;
    if (backpack && typeof backpack.connect === 'function') out.push({ name: 'Backpack', provider: backpack });
  } catch {
    /* hostile getters on window — ignore */
  }
  return out;
}

function findStandard(name: string): Wallet | undefined {
  return standardWallets().find((w) => norm(w.name) === norm(name));
}

function findLegacy(name: string): LegacyProvider | undefined {
  return legacyProviders().find((l) => norm(l.name) === norm(name))?.provider;
}

/* ------------------------------------------------------------------ on-demand wallets */

/**
 * Wallets this app registers itself, on demand (only the DEVNET test wallet, src/dev; nothing in other builds). App
 * installs the loader; the wallet list and the saved-session restore call `loadExtraWallets`, so the wallet's code
 * (and web3.js) loads only when someone is about to pick a wallet, never on the first paint.
 */
type ExtraLoader = (walletName?: string) => Promise<void>;
let extraLoader: ExtraLoader | null = null;
let extraPending = 0;
const extraListeners = new Set<() => void>();

export function setExtraWalletLoader(fn: ExtraLoader | null): void {
  extraLoader = fn;
}

/**
 * Load the on-demand wallets (no-op without a loader). `walletName`: only when it could be that wallet (the restore of
 * a saved session). Never rejects.
 */
export async function loadExtraWallets(walletName?: string): Promise<void> {
  if (!extraLoader) return;
  extraPending++;
  extraListeners.forEach((cb) => cb());
  try {
    await extraLoader(walletName);
  } catch {
    /* the list just shows the other wallets */
  } finally {
    extraPending--;
    extraListeners.forEach((cb) => cb());
  }
}

/** True while an on-demand wallet is still loading (the list shows a placeholder row). */
export function extraWalletsLoading(): boolean {
  return extraPending > 0;
}

export function onExtraWalletsLoading(cb: () => void): () => void {
  extraListeners.add(cb);
  return () => extraListeners.delete(cb);
}

/** True when a wallet with this name is available (standard or legacy). */
export function isWalletAvailable(name: string): boolean {
  return !!findStandard(name) || !!findLegacy(name);
}

/**
 * Wallet rows for the wallet modal: Phantom, Solflare, Backpack pinned first (installed or not),
 * then any other detected Solana wallets alphabetically (DESIGN §12.4).
 */
export function listWallets(): WalletInfo[] {
  const pinnedNames = PINNED_WALLETS.map(norm);
  const detected = new Map<string, WalletInfo>();
  for (const w of standardWallets()) {
    const key = norm(w.name);
    if (!detected.has(key)) detected.set(key, { name: w.name, icon: w.icon, installed: true, pinned: pinnedNames.includes(key) });
  }
  for (const l of legacyProviders()) {
    const key = norm(l.name);
    if (!detected.has(key)) detected.set(key, { name: l.name, installed: true, pinned: pinnedNames.includes(key) });
  }
  const mobile = isMobileNow();
  const here = typeof location !== 'undefined' ? location.href : '';
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const pinned: WalletInfo[] = PINNED_WALLETS.map((name) => {
    const found = detected.get(norm(name));
    if (found) return found;
    const browse = links.walletBrowse[name];
    return {
      name,
      installed: false,
      pinned: true,
      installUrl: links.walletInstall[name],
      openInAppUrl: mobile && browse ? browse(here, origin) : undefined,
    };
  });
  const others = [...detected.values()].filter((w) => !w.pinned).sort((a, b) => a.name.localeCompare(b.name));
  // Devnet: the test wallet (src/dev, registered only in devnet test builds) goes first.
  const testIdx = TEST_WALLET_NAME && IS_REAL && CLUSTER === 'devnet' ? others.findIndex((w) => w.name === TEST_WALLET_NAME) : -1;
  if (testIdx >= 0) {
    const [test] = others.splice(testIdx, 1);
    return [{ ...test, pinned: true }, ...pinned, ...others];
  }
  return [...pinned, ...others];
}

/** Re-render hook source: fires when wallets register/unregister. Returns an unsubscribe. */
export function subscribeWallets(cb: () => void): () => void {
  const r = registry();
  if (!r) return () => {};
  const offs = [r.on('register', cb), r.on('unregister', cb)];
  return () => offs.forEach((off) => off());
}

/** Resolve true once a wallet with this name shows up (wallets can inject after load). */
export function waitForWallet(name: string, timeoutMs = 3000): Promise<boolean> {
  if (isWalletAvailable(name)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      off();
      resolve(v);
    };
    const check = () => {
      if (isWalletAvailable(name)) finish(true);
    };
    const off = subscribeWallets(check);
    const poll = setInterval(check, 250);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/* ------------------------------------------------------------------ active session */

type Session =
  | { kind: 'standard'; name: string; wallet: Wallet; address: string; off: () => void }
  | { kind: 'legacy'; name: string; provider: LegacyProvider; address: string; off: () => void };

let active: Session | null = null;

export interface AccountChange {
  walletName: string;
  /** New address, or null when the wallet disconnected / revoked access. */
  address: string | null;
  icon?: string;
}

const accountListeners = new Set<(c: AccountChange) => void>();

/** Subscribe to account switches / disconnects coming from the connected wallet. */
export function onActiveAccountChange(cb: (c: AccountChange) => void): () => void {
  accountListeners.add(cb);
  return () => accountListeners.delete(cb);
}

function emit(change: AccountChange): void {
  for (const cb of [...accountListeners]) {
    try {
      cb(change);
    } catch {
      /* listener errors must not break others */
    }
  }
}

function endSession(): Session | null {
  const s = active;
  active = null;
  try {
    s?.off();
  } catch {
    /* ignore */
  }
  return s;
}

function pickAccount(accounts: readonly WalletAccount[]): WalletAccount | undefined {
  return accounts.find((a) => a.chains.some((c) => c.startsWith('solana:'))) ?? accounts[0];
}

function legacyAddress(result: unknown, provider: LegacyProvider): string | null {
  const fromResult =
    result && typeof result === 'object' && 'publicKey' in result
      ? (result as { publicKey?: { toString(): string } | null }).publicKey
      : null;
  const pk = fromResult ?? provider.publicKey ?? null;
  const s = pk ? pk.toString() : '';
  return s && isValidSolanaAddress(s) ? s : null;
}

/**
 * Connect a wallet by name (connect only — never signs). `silent` asks the wallet to reconnect
 * without a prompt (Wallet Standard `silent`, legacy `onlyIfTrusted`) for the next-visit restore.
 */
export async function connectWallet(
  name: string,
  opts: { silent?: boolean } = {},
): Promise<{ address: string; walletName: string; icon?: string }> {
  const silent = !!opts.silent;
  const timeoutMs = silent ? 6000 : 90_000;
  const std = findStandard(name);
  if (std) {
    const feature = std.features[CONNECT] as ConnectFeature | undefined;
    if (!feature || typeof feature.connect !== 'function') throw new WalletConnectError('not-found', std.name);
    let res: { accounts: readonly WalletAccount[] };
    try {
      res = await withTimeout(feature.connect(silent ? { silent: true } : undefined), timeoutMs, std.name);
    } catch (err) {
      throw classify(err, std.name);
    }
    const accounts = res?.accounts?.length ? res.accounts : std.accounts;
    const account = pickAccount(accounts);
    if (!account) throw new WalletConnectError('no-account', std.name);

    endSession();
    let off: () => void = () => {};
    const events = std.features[EVENTS] as EventsFeature | undefined;
    if (events && typeof events.on === 'function') {
      try {
        off = events.on('change', ({ accounts: next }) => {
          if (!next || active?.kind !== 'standard' || active.wallet !== std) return;
          const acc = pickAccount(next);
          if (!acc) {
            endSession();
            emit({ walletName: std.name, address: null });
          } else if (acc.address !== active.address) {
            active.address = acc.address;
            emit({ walletName: std.name, address: acc.address, icon: std.icon });
          }
        });
      } catch {
        off = () => {};
      }
    }
    active = { kind: 'standard', name: std.name, wallet: std, address: account.address, off };
    return { address: account.address, walletName: std.name, icon: std.icon };
  }

  const legacy = findLegacy(name);
  if (!legacy) throw new WalletConnectError('not-found', name);
  let result: unknown;
  try {
    result = await withTimeout(legacy.connect(silent ? { onlyIfTrusted: true } : undefined), timeoutMs, name);
  } catch (err) {
    throw classify(err, name);
  }
  const address = legacyAddress(result, legacy);
  if (!address) throw new WalletConnectError('no-account', name);

  endSession();
  const onChanged = (...args: unknown[]) => {
    if (active?.kind !== 'legacy' || active.provider !== legacy) return;
    const next = legacyAddress(args[0] ? { publicKey: args[0] } : null, legacy);
    if (!next) {
      endSession();
      emit({ walletName: name, address: null });
    } else if (next !== active.address) {
      active.address = next;
      emit({ walletName: name, address: next });
    }
  };
  const onDisconnect = () => {
    if (active?.kind !== 'legacy' || active.provider !== legacy) return;
    endSession();
    emit({ walletName: name, address: null });
  };
  try {
    legacy.on?.('accountChanged', onChanged);
    legacy.on?.('disconnect', onDisconnect);
  } catch {
    /* provider without events */
  }
  const off = () => {
    const remove = legacy.off ?? legacy.removeListener;
    try {
      remove?.call(legacy, 'accountChanged', onChanged);
      remove?.call(legacy, 'disconnect', onDisconnect);
    } catch {
      /* ignore */
    }
  };
  active = { kind: 'legacy', name, provider: legacy, address, off };
  return { address, walletName: name };
}

/** Disconnect the current wallet session (`standard:disconnect` where supported). Never throws. */
export async function disconnect(): Promise<void> {
  const s = endSession();
  if (!s) return;
  try {
    if (s.kind === 'standard') {
      const feature = s.wallet.features[DISCONNECT] as DisconnectFeature | undefined;
      if (feature && typeof feature.disconnect === 'function') await withTimeout(feature.disconnect(), 5000, s.name);
    } else if (typeof s.provider.disconnect === 'function') {
      await withTimeout(s.provider.disconnect(), 5000, s.name);
    }
  } catch {
    /* the app-side state is cleared regardless */
  }
}

/* ------------------------------------------------------------------ signing (real mode only) */

/**
 * The connected Wallet Standard wallet as a `WalletSigner` (INTEGRATION.md §4.9), or null when there is no connected
 * standard wallet, the wallet lacks `solana:signTransaction` (or v0 transactions), or it is a legacy provider / the
 * mocked email wallet. Throws in demo mode (`assertRealMode`).
 */
export function getSigner(): WalletSigner | null {
  assertRealMode('Signing');
  const s = active;
  if (!s || s.kind !== 'standard' || !CLUSTER) return null;
  const wallet = s.wallet;
  const signFeature = wallet.features[SIGN_TRANSACTION] as SignTransactionFeature | undefined;
  if (!signFeature || typeof signFeature.signTransaction !== 'function') return null;
  const versions = signFeature.supportedTransactionVersions;
  if (versions && !versions.includes(0)) return null;
  const chain = `solana:${CLUSTER}` as const;
  const address = s.address;
  const account = (): WalletAccount => {
    const acc = wallet.accounts.find((a) => a.address === address);
    if (!acc) throw new WalletConnectError('no-account', wallet.name, 'The wallet account changed. Reconnect and try again.');
    return acc;
  };
  const signer: WalletSigner = {
    address,
    walletName: wallet.name,
    chain,
    async signTransaction(serializedTx: Uint8Array): Promise<Uint8Array> {
      if (active !== s) throw new WalletConnectError('no-account', wallet.name, 'The wallet disconnected. Reconnect and try again.');
      const [out] = await signFeature.signTransaction({ account: account(), transaction: serializedTx, chain });
      if (!out?.signedTransaction) throw new WalletConnectError('error', wallet.name, 'The wallet returned no transaction.');
      return out.signedTransaction;
    },
  };
  const msgFeature = wallet.features[SIGN_MESSAGE] as SignMessageFeature | undefined;
  if (msgFeature && typeof msgFeature.signMessage === 'function') {
    signer.signMessage = async (message: Uint8Array): Promise<Uint8Array> => {
      const [out] = await msgFeature.signMessage({ account: account(), message });
      if (!out?.signature) throw new WalletConnectError('error', wallet.name, 'The wallet returned no signature.');
      return out.signature;
    };
  }
  return signer;
}

/* ------------------------------------------------------------------ email (mocked embedded wallet) */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmailLike(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

/** Mocked embedded wallet: a deterministic base58 address per email ("Embedded wallet (demo)"). */
export function createEmailWallet(email: string): { address: string } {
  return { address: fakeWallet(`email:${email.trim().toLowerCase()}`) };
}

/** `sam@example.com` → `s…@…com` (DESIGN §16.12). */
export function maskEmail(email: string): string {
  const e = email.trim();
  const at = e.indexOf('@');
  if (at < 1) return e;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const tld = domain.includes('.') ? domain.slice(domain.lastIndexOf('.') + 1) : domain;
  return `${local[0] ?? ''}…@…${tld}`;
}
