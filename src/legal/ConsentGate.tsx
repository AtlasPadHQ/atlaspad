/**
 * The one-time risk + Terms consent sheet (src/legal/consent.ts). It opens on top of the flow that asked for a
 * transaction; both boxes must be ticked to continue. Cancel, Esc or the scrim = declined, and nothing is sent.
 * SHARED (src/legal), mounted once by SharedModals.
 */
import { useEffect, useId, useState } from 'react';
import { links } from '../config';
import { CLUSTER } from '../mode';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Fields';
import { Icon } from '../ui/Icons';
import { Modal, ModalHeader } from '../ui/Modal';
import { resolveConsent, useConsentRequested } from './consent';
import './legal.css';

export function ConsentGate() {
  const open = useConsentRequested();
  const h = useId();
  const [adult, setAdult] = useState(false);
  const [terms, setTerms] = useState(false);

  useEffect(() => {
    if (open) {
      setAdult(false);
      setTerms(false);
    }
  }, [open]);

  const decline = () => resolveConsent(false);

  return (
    <Modal open={open} onClose={decline} labelledBy={h} width={480} className="consent-dlg" initialFocus=".consent-h">
      <ModalHeader onClose={decline} />
      <h2 id={h} className="consent-h" tabIndex={-1}>
        Before your first transaction
      </h2>
      <div className="dlg-box" role="note">
        <Icon name="warning" fill />
        <div>
          <b>Don't invest unless you're prepared to lose all the money you invest.</b>
          <small>This is a high-risk investment and you are unlikely to be protected if something goes wrong.</small>
        </div>
      </div>
      <ul className="consent-risks">
        <li>Memecoins can go to zero, often within minutes. Most do.</li>
        <li>Solana transactions are final. Nobody can reverse or refund them, including us.</li>
        <li>A coin isn't affiliated with its business unless the owner claims it.</li>
        <li>Smart contracts and third parties (pump.fun, Solana, your wallet) can fail. Nothing here is investment advice.</li>
      </ul>
      {CLUSTER === 'devnet' ? <p className="dlg-sub">You're on devnet: test SOL with no value. On mainnet the same steps use real money.</p> : null}
      <Checkbox checked={adult} onChange={(e) => setAdult(e.target.checked)}>
        I'm 18 or older, and I'm not in a blocked or restricted country or region, or using a VPN to get around one.
      </Checkbox>
      <Checkbox checked={terms} onChange={(e) => setTerms(e.target.checked)}>
        I accept the{' '}
        <a href={links.terms} target="_blank" rel="noopener noreferrer">
          Terms
        </a>{' '}
        and understand these risks. See also the{' '}
        <a href={links.privacy} target="_blank" rel="noopener noreferrer">
          Privacy
        </a>{' '}
        notice.
      </Checkbox>
      <footer className="dlg-f">
        <span className="dlg-f-spacer" />
        <Button variant="text" onClick={decline}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!adult || !terms} onClick={() => resolveConsent(true)}>
          Accept and continue
        </Button>
      </footer>
    </Modal>
  );
}
