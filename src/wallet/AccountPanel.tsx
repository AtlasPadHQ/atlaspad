/**
 * Connected-wallet account menu body (DESIGN §6.4): avatar + short address + Copy + balance,
 * then My coins / View on Solscan / Disconnect. Rendered in the desktop pill's popover and in
 * the mobile account bottom sheet (store.modal.kind === 'account').
 */
import { links } from '../config';
import { copyWithToast } from '../lib/clipboard';
import { shortAddr, solNumber, usdFull } from '../lib/format';
import { openExternal } from '../lib/nav';
import { CLUSTER, IS_REAL } from '../mode';
import { useWalletPolling } from '../realdata/hooks';
import { getTestSol } from '../realdata/tx';
import { solFloor } from '../realdata/units';
import { useStore } from '../store';
import type { WalletState } from '../types';
import { AddrBlob, IconButton, Icon } from '../ui';
import { disconnect } from './solanaWallets';
import './wallet.css';

/** 28/40px wallet icon (Wallet Standard data URI), or the address blob for email wallets. */
export function WalletAvatar({ wallet, size = 28 }: { wallet: WalletState; size?: number }) {
  if (wallet.icon && wallet.kind === 'standard') {
    return <img className="wicon" src={wallet.icon} alt="" width={size} height={size} draggable={false} />;
  }
  return wallet.address ? <AddrBlob address={wallet.address} size={size} /> : null;
}

/** Human label for the wallet ("Phantom", "Embedded wallet (demo)"). */
export function walletLabel(wallet: WalletState): string {
  if (wallet.kind === 'email') return IS_REAL ? 'Email wallet (can’t sign)' : 'Embedded wallet (demo)';
  return wallet.walletName ?? 'Solana wallet';
}

/** Disconnect everything: `standard:disconnect`, clear cs_wallet, toast. */
export async function disconnectWallet(): Promise<void> {
  await disconnect();
  const st = useStore.getState();
  st.disconnectWallet();
  st.toast('Disconnected');
}

export function AccountPanel({ onDone }: { onDone: () => void }) {
  const wallet = useStore((s) => s.wallet);
  const sol = useStore((s) => s.solBalance);
  const lamports = useStore((s) => s.balanceLamports);
  const solUsd = useStore((s) => s.solUsd);
  const setPanel = useStore((s) => s.setPanel);
  // real mode: fresh balance while the menu is open (§5.2)
  useWalletPolling();
  const address = wallet.address;
  if (!address) return null;
  // real mode: exact lamports, 4 dp rounded down; `…` until the first read
  const solText = IS_REAL ? (lamports != null ? `${solFloor(lamports, 4)} SOL` : '… SOL') : `${solNumber(sol)} SOL`;

  return (
    <div className="acct">
      <div className="acct-h">
        <WalletAvatar wallet={wallet} size={40} />
        <div className="acct-id">
          <b className="num" translate="no">
            {shortAddr(address)}
          </b>
          <small>{walletLabel(wallet)}</small>
          <span className="acct-bal num">
            {solText} · {usdFull(sol * solUsd)}
            {IS_REAL && CLUSTER === 'devnet' ? ' (test)' : ''}
          </span>
        </div>
        <IconButton icon="content_copy" label="Copy address" onClick={() => void copyWithToast(address, 'Address copied')} />
      </div>
      <div className="acct-rows">
        <button
          type="button"
          className="acct-row"
          onClick={() => {
            onDone();
            setPanel('mine');
          }}
        >
          <Icon name="account_balance_wallet" size={20} />
          My coins
        </button>
        <button
          type="button"
          className="acct-row"
          onClick={() => {
            onDone();
            openExternal(links.solscanAccount(address));
          }}
        >
          <Icon name="open_in_new" size={20} />
          View on Solscan
        </button>
        {IS_REAL && CLUSTER === 'devnet' ? (
          <button
            type="button"
            className="acct-row"
            onClick={() => {
              onDone();
              void getTestSol();
            }}
          >
            <Icon name="water_drop" size={20} />
            Get test SOL
          </button>
        ) : null}
        <button
          type="button"
          className="acct-row"
          onClick={() => {
            onDone();
            void disconnectWallet();
          }}
        >
          <Icon name="logout" size={20} />
          Disconnect
        </button>
      </div>
    </div>
  );
}
