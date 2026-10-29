/**
 * The one-time risk + Terms consent gate (src/legal): stored with a version per cluster, one shared sheet, and wired
 * into runTx, the single path every launch / trade / claim / finalize / withdraw starts from, so no flow skips it.
 * Declining sends nothing. The demo never asks.
 */
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnProgress, TxOutcome, WalletSigner } from '../chain/types';
import type { TxKind } from '../types';

const { signer } = vi.hoisted(() => ({
  signer: { address: 'Wa11et1111111111111111111111111111111111111', walletName: 'Test Wallet', chain: 'solana:devnet', signTransaction: async (b: Uint8Array) => b },
}));
// a connected wallet that can sign (the gate sits before the signer is used)
vi.mock('../wallet/solanaWallets', async (importOriginal) => ({ ...(await importOriginal<object>()), getSigner: () => signer as WalletSigner }));
// Modal portals to <body>, which server rendering can't do: render the sheet's content inline
vi.mock('../ui/Modal', () => ({
  Modal: ({ open, children }: { open: boolean; children: unknown }) => (open ? h('section', { role: 'dialog' }, children as never) : null),
  ModalHeader: () => null,
}));

class MemStorage {
  map = new Map<string, string>();
  blocked = false;
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.blocked) throw new Error('QuotaExceededError');
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}
const local = new MemStorage();

type Mods = {
  consent: typeof import('./consent');
  tx: typeof import('../realdata/tx');
  store: typeof import('../store');
  gate: typeof import('./ConsentGate');
};
let m: Mods;

beforeAll(async () => {
  vi.stubEnv('VITE_CLUSTER', 'devnet');
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible', hidden: false, querySelector: () => null }));
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout, localStorage: local, sessionStorage: new MemStorage() }));
  vi.resetModules();
  m = {
    consent: await import('./consent'),
    tx: await import('../realdata/tx'),
    store: await import('../store'),
    gate: await import('./ConsentGate'),
  };
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

beforeEach(() => {
  m.consent.resolveConsent(false);
  m.consent.clearConsent();
  local.blocked = false;
  local.map.clear();
  m.store.useStore.setState({ tx: null });
});

const okOp = () => vi.fn(async (_signer: WalletSigner, _onProgress: OnProgress): Promise<TxOutcome<number>> => ({ ok: true, signature: 'sig', explorerUrl: 'https://solscan.io/tx/sig', value: 1 }));
const stored = () => JSON.parse(local.map.get(m.consent.CONSENT_KEY) ?? 'null') as unknown;

describe('consent record (devnet real mode)', () => {
  it('asks once: one shared sheet, stored with the version and the cluster', async () => {
    const { consent } = m;
    expect(consent.hasConsent()).toBe(false);
    const a = consent.requestConsent();
    const b = consent.requestConsent();
    expect(b).toBe(a);
    expect(consent.consentRequested()).toBe(true);
    consent.resolveConsent(true);
    await expect(a).resolves.toBe(true);
    expect(consent.consentRequested()).toBe(false);
    expect(stored()).toMatchObject({ v: consent.CONSENT_VERSION, cluster: 'devnet', at: expect.any(Number) });
    expect(consent.hasConsent()).toBe(true);
    await expect(consent.requestConsent()).resolves.toBe(true);
    expect(consent.consentRequested()).toBe(false);
  });

  it('an older version, another cluster or a broken record asks again', () => {
    const { consent } = m;
    const at = Date.now();
    for (const bad of [{ v: consent.CONSENT_VERSION - 1, cluster: 'devnet', at }, { v: consent.CONSENT_VERSION, cluster: 'mainnet', at }, { v: consent.CONSENT_VERSION, cluster: 'devnet' }, 'yes', null]) {
      local.map.set(consent.CONSENT_KEY, JSON.stringify(bad));
      expect(consent.hasConsent(), JSON.stringify(bad)).toBe(false);
    }
    local.map.set(consent.CONSENT_KEY, '{not json');
    expect(consent.hasConsent()).toBe(false);
    local.map.set(consent.CONSENT_KEY, JSON.stringify({ v: consent.CONSENT_VERSION, cluster: 'devnet', at }));
    expect(consent.hasConsent()).toBe(true);
  });

  it('blocked storage: the acceptance lasts for this page load', async () => {
    const { consent } = m;
    local.blocked = true;
    const p = consent.requestConsent();
    consent.resolveConsent(true);
    await expect(p).resolves.toBe(true);
    expect(local.map.size).toBe(0);
    expect(consent.hasConsent()).toBe(true);
  });
});

describe('runTx waits for consent before the first transaction', () => {
  it('declining sends nothing: the wallet is never asked and no tx state is set', async () => {
    const op = okOp();
    const out = m.tx.runTx('buy', 'ChIJplace', op);
    expect(m.consent.consentRequested()).toBe(true);
    expect(op).not.toHaveBeenCalled();
    m.consent.resolveConsent(false);
    const r = await out;
    expect(r).toEqual({ ok: false, error: m.consent.consentDeclinedError() });
    expect(r.ok || (r.error.code === 'rejected' && !r.error.sent)).toBe(true);
    expect(op).not.toHaveBeenCalled();
    expect(m.store.useStore.getState().tx).toBeNull();
    expect(stored()).toBeNull();
  });

  it('accepting continues the same transaction; later ones never ask and start synchronously', async () => {
    const op = okOp();
    const out = m.tx.runTx('launch', 'ChIJplace', op);
    expect(op).not.toHaveBeenCalled();
    m.consent.resolveConsent(true);
    const r = await out;
    expect(r.ok).toBe(true);
    expect(op).toHaveBeenCalledTimes(1);
    expect(op.mock.calls[0]![0]).toBe(signer);
    // consent on record: no sheet, and the op runs in the same tick (callers may read store.tx right away)
    const next = m.tx.runTx('sell', 'ChIJplace', op);
    expect(m.consent.consentRequested()).toBe(false);
    expect(op).toHaveBeenCalledTimes(2);
    expect((await next).ok).toBe(true);
  });

  it('every kind of transaction goes through the gate', async () => {
    const kinds: TxKind[] = ['launch', 'buy', 'sell', 'claim', 'finalize', 'withdraw'];
    for (const kind of kinds) {
      m.consent.clearConsent();
      const op = okOp();
      const out = m.tx.runTx(kind, 'ChIJplace', op);
      expect(m.consent.consentRequested(), kind).toBe(true);
      m.consent.resolveConsent(false);
      expect((await out).ok, kind).toBe(false);
      expect(op, kind).not.toHaveBeenCalled();
    }
  });

  it('two flows asking at once share one sheet and one answer', async () => {
    const op = okOp();
    const a = m.tx.runTx('buy', 'ChIJplace', op);
    const b = m.tx.runTx('claim', 'ChIJother', op);
    m.consent.resolveConsent(true);
    await Promise.all([a, b]);
    expect(op).toHaveBeenCalledTimes(2);
  });
});

describe('the consent sheet', () => {
  const text = (html: string) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

  it('is closed until a transaction asks', () => {
    expect(renderToString(h(m.gate.ConsentGate))).toBe('');
  });

  it('shows the risk warning, the age + region and Terms confirmations, and links the Terms', () => {
    void m.consent.requestConsent();
    const html = renderToString(h(m.gate.ConsentGate));
    const t = text(html);
    expect(t).toContain('Before your first transaction');
    expect(t).toContain("Don't invest unless you're prepared to lose all the money you invest.");
    expect(t).toContain('Memecoins can go to zero');
    expect(t).toContain('Solana transactions are final');
    expect(t).toContain("I'm 18 or older, and I'm not in a blocked or restricted country or region, or using a VPN to get around one.");
    expect(t).toContain('I accept the Terms and understand these risks.');
    expect(t).toContain("You're on devnet");
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    // nothing can be accepted before both boxes are ticked
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Accept and continue/);
  });
});

describe('demo mode', () => {
  it('never asks (the demo sends no transactions)', async () => {
    vi.stubEnv('VITE_CLUSTER', '');
    vi.resetModules();
    const consent = await import('./consent');
    expect(consent.hasConsent()).toBe(true);
    await expect(consent.requestConsent()).resolves.toBe(true);
    expect(consent.consentRequested()).toBe(false);
  });
});
