/**
 * DEVNET-ONLY dev tools (INTEGRATION.md §6, H6): registers the "Devnet Test Wallet" with the Wallet Standard.
 *
 * Triple-guarded so it can never run on mainnet:
 *   1. compile time — App.tsx imports this file only inside
 *      `import.meta.env.VITE_TEST_WALLET === '1' && import.meta.env.VITE_CLUSTER === 'devnet'` (dead code elsewhere,
 *      so the chunk is not emitted; scripts/check-bundle.mjs proves the marker is absent from dist-mainnet);
 *   2. the same compile-time check again here;
 *   3. runtime — real mode, `CLUSTER === 'devnet'`, `/api/config` says devnet (and the devnet genesis hash) with
 *      `features.testWallet` (the Worker sets it only with __CS_DEV_ENDPOINTS__ on devnet; it does NOT depend on the
 *      faucet's balance — a funded test wallet must stay usable when the faucet runs low; `features.faucet` gates
 *      only the automatic top-up).
 *
 * Loaded on demand (App.tsx registers a loader with src/wallet/solanaWallets): when a wallet list opens, or at boot
 * when the saved session is this wallet. Visitors who never open the wallet list never download it (or web3.js).
 */
import '../chain/polyfills';
import { registerWallet } from '@wallet-standard/wallet';
import type { ConfigResponse } from '../../worker/wire';
import { GENESIS } from '../chain/constants';
import { CLUSTER, IS_REAL } from '../mode';
import { useStore } from '../store';
import { DevnetTestWallet, TEST_WALLET_MARKER } from './testWallet';

declare global {
  interface Window {
    /** E2E handle (devnet test builds only). Never holds the secret key. */
    __csTestWallet?: { readonly address: string | null; airdrop(): Promise<string | null>; readonly marker: string };
  }
}

let installed: DevnetTestWallet | null = null;

export function installDevTools(config: ConfigResponse): void {
  if (!(import.meta.env.VITE_TEST_WALLET === '1' && import.meta.env.VITE_CLUSTER === 'devnet')) return;
  if (!IS_REAL || CLUSTER !== 'devnet') return;
  if (config.cluster !== 'devnet' || config.genesisHash !== GENESIS.devnet || !config.features.testWallet) return;
  if (installed || typeof window === 'undefined') return;

  const wallet = new DevnetTestWallet(
    (msg, kind = 'info') => {
      try {
        useStore.getState().toast(msg, kind, undefined, kind === 'info' ? 'science' : undefined);
      } catch {
        /* toast is cosmetic */
      }
    },
    // the latest /api/config (polled every 60 s) says whether the faucet can pay out right now
    () => useStore.getState().chain.config?.features.faucet ?? config.features.faucet ?? true,
  );
  installed = wallet;
  registerWallet(wallet);
  window.__csTestWallet = {
    get address() {
      return wallet.address;
    },
    async airdrop() {
      const l = await wallet.airdrop();
      return l === null ? null : l.toString();
    },
    marker: TEST_WALLET_MARKER,
  };
}
