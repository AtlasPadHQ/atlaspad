/**
 * Top-right wallet pill + desktop account menu (DESIGN §6.4). Rendered by App inside `.topright`
 * (hidden on mobile by CSS, but always mounted), so it also owns:
 *  - the silent reconnect on load (localStorage cs_wallet → `standard:connect` with `silent`),
 *  - account switches / disconnects reported by the connected wallet (`standard:events`).
 * Contract: default export, no props.
 */
import { useEffect, useRef, useState } from 'react';
import { STORAGE_KEYS } from '../config';
import { shortAddr } from '../lib/format';
import { useBreakpoint } from '../lib/media';
import { loadJSON } from '../lib/storage';
import { connectedToast, useStore } from '../store';
import { Icon, Popover } from '../ui';
import { AccountPanel, WalletAvatar } from './AccountPanel';
import { connectWallet, loadExtraWallets, onActiveAccountChange, waitForWallet } from './solanaWallets';
import './wallet.css';

let restoreStarted = false;

/** Silent reconnect of the last Wallet Standard wallet (email wallets are restored by the store). */
function useSilentReconnect(): void {
  useEffect(() => {
    if (restoreStarted) return;
    restoreStarted = true;
    const saved = loadJSON<{ kind?: string; walletName?: string } | null>(STORAGE_KEYS.wallet, null);
    if (saved?.kind !== 'standard' || typeof saved.walletName !== 'string' || !saved.walletName) return;
    const name = saved.walletName;
    void (async () => {
      if (useStore.getState().wallet.address) return;
      // wallets this app registers on demand (devnet test wallet) load first; a no-op for extension wallets
      await loadExtraWallets(name);
      const available = await waitForWallet(name, 3000);
      if (!available || useStore.getState().wallet.address) return;
      try {
        const r = await connectWallet(name, { silent: true });
        if (useStore.getState().wallet.address) return; // the user connected something else meanwhile
        useStore.getState().setWallet({ address: r.address, kind: 'standard', walletName: r.walletName, icon: r.icon });
      } catch {
        /* not trusted any more / wallet locked: stay disconnected, no toast */
      }
    })();
  }, []);
}

/** Follow account switches and disconnects coming from the wallet itself. */
function useAccountChanges(): void {
  useEffect(
    () =>
      onActiveAccountChange(({ walletName, address, icon }) => {
        const st = useStore.getState();
        if (st.wallet.kind !== 'standard') return;
        if (!address) {
          st.disconnectWallet();
          st.toast('Disconnected');
          return;
        }
        if (address === st.wallet.address) return;
        st.setWallet({ address, kind: 'standard', walletName, icon: icon ?? st.wallet.icon });
        st.toast(connectedToast(address), 'ok');
      }),
    [],
  );
}

export default function ConnectWalletPill() {
  useSilentReconnect();
  useAccountChanges();
  const wallet = useStore((s) => s.wallet);
  const connecting = useStore((s) => s.walletConnecting);
  const openModal = useStore((s) => s.openModal);
  const bp = useBreakpoint();
  const compact = bp === 'tablet';
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  // close the menu when the wallet goes away
  useEffect(() => {
    if (!wallet.address) setMenu(false);
  }, [wallet.address]);

  if (!wallet.address) {
    const label = connecting ? 'Connecting…' : 'Connect wallet';
    return (
      <button
        type="button"
        className={['wallet-btn', connecting ? 'is-busy' : ''].filter(Boolean).join(' ')}
        aria-busy={connecting ? true : undefined}
        aria-label={compact ? label : undefined}
        data-tip={compact ? label : undefined}
        onClick={() => openModal({ kind: 'wallet' })}
        onPointerEnter={() => void loadExtraWallets()}
        onFocus={() => void loadExtraWallets()}
      >
        {connecting ? <Icon name="progress_activity" spin /> : <Icon name="account_balance_wallet" />}
        <span className="wallet-lbl">{label}</span>
      </button>
    );
  }

  const short = shortAddr(wallet.address);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="wallet-btn on"
        aria-haspopup="dialog"
        aria-expanded={menu}
        aria-label={`Wallet ${short}, account menu`}
        data-tip={compact ? short : undefined}
        onClick={() => setMenu((m) => !m)}
      >
        <WalletAvatar wallet={wallet} size={28} />
        <span className="wallet-addr num" translate="no">
          {short}
        </span>
        <Icon name="expand_more" size={20} className="wallet-caret" />
      </button>
      <Popover anchor={ref} open={menu} onClose={() => setMenu(false)} placement="bottom-end" offset={4} width={280} className="acct-pop" ariaLabel="Account">
        <AccountPanel onDone={() => setMenu(false)} />
      </Popover>
    </>
  );
}
