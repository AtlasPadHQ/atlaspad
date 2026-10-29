/**
 * cs-devnet-test-wallet-v1 — the DEVNET-ONLY "Devnet Test Wallet" (INTEGRATION.md §6), a Wallet Standard wallet
 * backed by a local keypair, for automated browser E2E without an extension. Loaded only through src/dev/index.ts
 * (inline-guarded dynamic import in App.tsx; absent from mainnet bundles — scripts/check-bundle.mjs greps for the
 * marker above).
 *
 *  - `standard:connect` never prompts: it creates or loads the keypair from localStorage `cs_devnet_test_wallet_v1`
 *    (try/catch; falls back to an in-memory key). The secret key is NEVER exposed on window or logged.
 *  - `solana:signTransaction` auto-approves (toast "Signed by Devnet Test Wallet"), keeping existing co-signatures.
 *  - `solana:signMessage`, `solana:signAndSendTransaction` (sends through `/api/rpc`).
 *  - On connect, under 0.5 SOL and while the faucet can pay → `POST /api/dev/airdrop` (toast "Getting test SOL…").
 */
import '../chain/polyfills';
import { Ed25519Program, Keypair, VersionedTransaction } from '@solana/web3.js';
import type { Wallet, WalletAccount, WalletIcon } from '@wallet-standard/base';
import { ReadonlyWalletAccount } from '@wallet-standard/wallet';
import type { DevAirdropResponse } from '../../worker/wire';
import { base58Decode } from '../chain/base58';
import { bytesToB64, getBalance, rpc } from '../chain/rpc';

export const TEST_WALLET_MARKER = 'cs-devnet-test-wallet-v1';
export const TEST_WALLET_NAME = 'Devnet Test Wallet';
const STORAGE_KEY = 'cs_devnet_test_wallet_v1';
const CHAIN = 'solana:devnet' as const;
const AIRDROP_BELOW_LAMPORTS = 500_000_000n;

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#7b4fd5"/>' +
  '<path d="M26 14h12v4h-2v10l11 18a4 4 0 0 1-3.4 6H20.4a4 4 0 0 1-3.4-6l11-18V18h-2z" fill="#ede7ff"/>' +
  '<path d="M22.6 42h18.8l3 5H19.6z" fill="#3b2a8c"/></svg>';
const ICON = `data:image/svg+xml;base64,${btoa(ICON_SVG)}` as WalletIcon;

export type Notify = (msg: string, kind?: 'info' | 'ok' | 'error') => void;

function loadOrCreateKeypair(): Keypair {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const bytes = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
      if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
    }
  } catch {
    /* storage blocked: fall through to a fresh key */
  }
  const kp = Keypair.generate();
  try {
    localStorage.setItem(STORAGE_KEY, bytesToB64(kp.secretKey));
  } catch {
    /* in-memory only (private window): a fresh wallet per page load */
  }
  return kp;
}

type ChangeListener = (props: { accounts?: readonly WalletAccount[] }) => void;

export class DevnetTestWallet implements Wallet {
  readonly version = '1.0.0' as const;
  readonly name = TEST_WALLET_NAME;
  readonly icon = ICON;
  readonly chains = [CHAIN] as const;
  #kp: Keypair | null = null;
  #accounts: WalletAccount[] = [];
  #listeners = new Set<ChangeListener>();
  #notify: Notify;
  #faucetReady: () => boolean;

  /** `faucetReady`: whether the Worker faucet can pay out now (`/api/config` features.faucet); gates the auto top-up. */
  constructor(notify: Notify, faucetReady: () => boolean = () => true) {
    this.#notify = notify;
    this.#faucetReady = faucetReady;
  }

  get accounts(): readonly WalletAccount[] {
    return this.#accounts;
  }

  /** Public address once connected (exposed for E2E as window.__csTestWallet.address). */
  get address(): string | null {
    return this.#kp && this.#accounts.length ? this.#kp.publicKey.toBase58() : null;
  }

  get features() {
    return {
      'standard:connect': { version: '1.0.0' as const, connect: this.#connect },
      'standard:disconnect': { version: '1.0.0' as const, disconnect: this.#disconnect },
      'standard:events': { version: '1.0.0' as const, on: this.#on },
      'solana:signTransaction': { version: '1.0.0' as const, supportedTransactionVersions: ['legacy', 0] as const, signTransaction: this.#signTransaction },
      'solana:signMessage': { version: '1.0.0' as const, signMessage: this.#signMessage },
      'solana:signAndSendTransaction': {
        version: '1.0.0' as const,
        supportedTransactionVersions: ['legacy', 0] as const,
        signAndSendTransaction: this.#signAndSendTransaction,
      },
    };
  }

  #emit(): void {
    for (const l of [...this.#listeners]) {
      try {
        l({ accounts: this.#accounts });
      } catch {
        /* listener errors must not break the wallet */
      }
    }
  }

  #on = (event: string, listener: ChangeListener): (() => void) => {
    if (event !== 'change') return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #connect = async (): Promise<{ accounts: readonly WalletAccount[] }> => {
    this.#kp ??= loadOrCreateKeypair();
    if (!this.#accounts.length) {
      this.#accounts = [
        new ReadonlyWalletAccount({
          address: this.#kp.publicKey.toBase58(),
          publicKey: this.#kp.publicKey.toBytes(),
          chains: [CHAIN],
          features: ['solana:signTransaction', 'solana:signMessage', 'solana:signAndSendTransaction'],
          label: TEST_WALLET_NAME,
          icon: ICON,
        }),
      ];
      this.#emit();
    }
    void this.topUpIfLow();
    return { accounts: this.#accounts };
  };

  #disconnect = async (): Promise<void> => {
    this.#accounts = [];
    this.#emit();
  };

  #requireKey(account?: WalletAccount): Keypair {
    const kp = this.#kp;
    if (!kp || !this.#accounts.length) throw new Error('Devnet Test Wallet is not connected');
    if (account && account.address !== kp.publicKey.toBase58()) throw new Error('Unknown account');
    return kp;
  }

  #signOne(kp: Keypair, bytes: Uint8Array): Uint8Array {
    const tx = VersionedTransaction.deserialize(bytes);
    tx.sign([kp]); // sets only our slot; existing co-signatures (attestor, mint) stay
    return tx.serialize();
  }

  #signTransaction = async (...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]) => {
    const out = inputs.map((i) => {
      if (i.chain && i.chain !== CHAIN) throw new Error(`Devnet Test Wallet only signs on ${CHAIN}`);
      return { signedTransaction: this.#signOne(this.#requireKey(i.account), i.transaction) };
    });
    this.#notify('Signed by Devnet Test Wallet', 'ok');
    return out;
  };

  #signMessage = async (...inputs: { account: WalletAccount; message: Uint8Array }[]) => {
    return inputs.map((i) => {
      const kp = this.#requireKey(i.account);
      // web3.js signs inside the ed25519 precompile instruction: signature at bytes 48..112 of its data.
      const ix = Ed25519Program.createInstructionWithPrivateKey({ privateKey: kp.secretKey, message: i.message });
      const signature = Uint8Array.from(ix.data.subarray(48, 112));
      return { signedMessage: i.message, signature };
    });
  };

  #signAndSendTransaction = async (...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]) => {
    const out: { signature: Uint8Array }[] = [];
    for (const i of inputs) {
      if (i.chain && i.chain !== CHAIN) throw new Error(`Devnet Test Wallet only sends on ${CHAIN}`);
      const signed = this.#signOne(this.#requireKey(i.account), i.transaction);
      const sig = await rpc<string>('sendTransaction', [bytesToB64(signed), { encoding: 'base64', maxRetries: 5 }], 15_000);
      out.push({ signature: base58Decode(sig) });
    }
    this.#notify('Signed by Devnet Test Wallet', 'ok');
    return out;
  };

  /** POST /api/dev/airdrop (devnet faucet; the Worker enforces caps). Returns lamports added, or null. */
  async airdrop(): Promise<bigint | null> {
    const address = this.address;
    if (!address) return null;
    this.#notify('Getting test SOL…', 'info');
    try {
      const res = await fetch('/api/dev/airdrop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) });
      const body = (await res.json().catch(() => null)) as (DevAirdropResponse & { error?: string; message?: string }) | null;
      if (!res.ok || !body?.lamports) {
        // the Worker's own reason when it gave one ("This wallet already has test SOL", faucet empty, daily cap)
        const why =
          body?.error === 'faucet_cap'
            ? 'The test faucet limit is reached for today.'
            : body?.error === 'faucet_empty'
              ? 'The test faucet is empty.'
              : typeof body?.message === 'string' && body.message && body.message.length <= 120
                ? body.message.replace(/\.?$/, '.')
                : "Couldn't get test SOL.";
        this.#notify(body?.error === 'bad_request' ? why : `${why} Try faucet.solana.com.`, 'error');
        return null;
      }
      this.#notify(`Added ${(Number(body.lamports) / 1e9).toFixed(2)} test SOL`, 'ok');
      return BigInt(body.lamports);
    } catch {
      this.#notify("Couldn't get test SOL. Try faucet.solana.com.", 'error');
      return null;
    }
  }

  async topUpIfLow(): Promise<void> {
    const address = this.address;
    // no automatic request while the faucet cannot pay ("Get test SOL" still asks and shows the reason)
    if (!address || !this.#faucetReady()) return;
    try {
      if ((await getBalance(address)) < AIRDROP_BELOW_LAMPORTS) await this.airdrop();
    } catch {
      /* balance unknown: the user can still use "Get test SOL" */
    }
  }
}
