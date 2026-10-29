/**
 * Wallet / sign-in modal (DESIGN §12.4) for store.modal.kind === 'wallet' — runs `modal.then`
 * after a successful connect (cancel = nothing) — and the mobile account sheet for
 * kind === 'account' (DESIGN §6.4 "Mobile .wallet-mini … connected → account menu as a bottom sheet").
 * Contract: default export, no props.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useStore } from '../store';
import { Modal, ModalHeader } from '../ui';
import { AccountPanel } from './AccountPanel';
import { WalletPicker } from './WalletPicker';
import './wallet.css';

export default function WalletModal() {
  const walletOpen = useStore((s) => s.modal?.kind === 'wallet');
  const accountOpen = useStore((s) => s.modal?.kind === 'account');
  const hasAddress = useStore((s) => !!s.wallet.address);
  const closeModal = useStore((s) => s.closeModal);
  const h = useId();

  // fresh picker state on every open
  const [openCount, setOpenCount] = useState(0);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (walletOpen && !wasOpen.current) setOpenCount((n) => n + 1);
    wasOpen.current = walletOpen;
  }, [walletOpen]);

  // the account sheet has nothing to show once disconnected
  useEffect(() => {
    if (accountOpen && !hasAddress) closeModal();
  }, [accountOpen, hasAddress, closeModal]);

  const onConnected = () => {
    const m = useStore.getState().modal;
    const then = m?.kind === 'wallet' ? m.then : undefined;
    if (m?.kind === 'wallet') closeModal();
    then?.();
  };

  return (
    <>
      <Modal open={walletOpen} onClose={closeModal} labelledBy={h} width={420} className="wallet-dlg">
        <ModalHeader onClose={closeModal} />
        <WalletPicker
          key={openCount}
          title="Connect"
          sub="Sign in to launch, trade and claim."
          headingId={h}
          terms
          onConnected={onConnected}
        />
      </Modal>
      <Modal open={accountOpen && hasAddress} onClose={closeModal} ariaLabel="Account" width={420} className="account-dlg">
        <ModalHeader onClose={closeModal} />
        <AccountPanel onDone={closeModal} />
      </Modal>
    </>
  );
}
