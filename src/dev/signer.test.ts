/**
 * getSigner() (src/wallet/solanaWallets.ts) end to end through the Wallet Standard registry, with the Devnet Test
 * Wallet as the registered wallet: real mode signs; demo mode refuses (assertRealMode) and never reads a signing
 * feature.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

function fakeBrowser(): void {
  const target = new EventTarget();
  const w = Object.assign(target, {
    location: { href: 'http://localhost/', origin: 'http://localhost', search: '' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    navigator: { userAgent: 'node' },
  });
  vi.stubGlobal('window', w);
  vi.stubGlobal('location', w.location);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../mode');
});

async function setup(real: boolean) {
  fakeBrowser();
  vi.doMock('../mode', () => ({
    BUILD_CLUSTER: real ? 'devnet' : null,
    TEST_WALLET_BUILD: false,
    APP_MODE: real ? 'real' : 'demo',
    IS_REAL: real,
    CLUSTER: real ? 'devnet' : null,
    assertRealMode: (what: string) => {
      if (!real) throw new Error(`${what} is not available in demo mode`);
    },
  }));
  const { registerWallet } = await import('@wallet-standard/wallet');
  const { DevnetTestWallet } = await import('./testWallet');
  const wallets = await import('../wallet/solanaWallets');
  const w = new DevnetTestWallet(() => {});
  w.topUpIfLow = async () => {};
  registerWallet(w);
  return { wallets, w };
}

describe('getSigner (Wallet Standard solana:signTransaction)', () => {
  test('real mode: wraps the connected wallet; signs v0 txs on solana:devnet; keeps co-signatures', async () => {
    const { wallets } = await setup(true);
    const conn = await wallets.connectWallet('Devnet Test Wallet');
    const signer = wallets.getSigner();
    expect(signer).not.toBeNull();
    expect(signer!.address).toBe(conn.address);
    expect(signer!.walletName).toBe('Devnet Test Wallet');
    expect(signer!.chain).toBe('solana:devnet');
    expect(typeof signer!.signMessage).toBe('function');
    const co = Keypair.generate();
    const me = new PublicKey(conn.address);
    const msg = new TransactionMessage({
      payerKey: me,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [SystemProgram.transfer({ fromPubkey: co.publicKey, toPubkey: me, lamports: 1 })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([co]);
    const signed = VersionedTransaction.deserialize(await signer!.signTransaction(tx.serialize()));
    expect(signed.signatures[0].some((b) => b !== 0)).toBe(true);
    expect(Array.from(signed.signatures[1])).toEqual(Array.from(tx.signatures[1]));
    // After a disconnect the old signer refuses.
    await wallets.disconnect();
    await expect(signer!.signTransaction(tx.serialize())).rejects.toThrow();
    expect(wallets.getSigner()).toBeNull();
  });

  test('demo mode: getSigner throws before touching any signing feature', async () => {
    const { wallets, w } = await setup(false);
    await wallets.connectWallet('Devnet Test Wallet');
    const spy = vi.spyOn(w, 'features', 'get');
    expect(() => wallets.getSigner()).toThrow(/demo mode/);
    expect(spy).not.toHaveBeenCalled();
  });

  test('legacy-only / no wallet → null', async () => {
    const { wallets } = await setup(true);
    expect(wallets.getSigner()).toBeNull();
  });
});
