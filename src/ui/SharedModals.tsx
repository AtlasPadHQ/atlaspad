/**
 * Shared single-purpose sheets (DESIGN §12.6), rendered by App from `store.modal`:
 *   demo     → DEMO explainer (demo mode only; real mode renders nothing)
 *   network  → Devnet explainer (real mode, INTEGRATION.md §7.1)
 *   report   → Report this coin (with no coin selected: a `Coin link or mint` field)
 *   optout   → Business opt-out (claim the fees / ask us to hide it)
 *   lightbox → Coin art lightbox
 * Plus the one-time risk + Terms consent sheet (src/legal), which opens on top of any of them.
 * Demo mode stores nothing from these forms (toast only). Real mode sends Report / opt-out to
 * `POST /api/report` (INTEGRATION.md §7.6). SHARED (src/ui).
 */
import { useEffect, useId, useState } from 'react';
import { ConsentGate } from '../legal/ConsentGate';
import { CONTACT_EMAIL } from '../legal/contact';
import { copyWithToast } from '../lib/clipboard';
import { mintFromCoinRef } from '../lib/coinRef';
import { CLUSTER, IS_REAL } from '../mode';
import { api, apiErrorMessage } from '../realdata/api';
import { FAUCET_URL, getTestSol } from '../realdata/tx';
import { openExternal } from '../lib/nav';
import { useStore } from '../store';
import type { ModalState, ReportReason } from '../types';
import { Button, IconButton } from './Button';
import { OptionCard, OptionGroup, TextArea, TextField } from './Fields';
import { Icon } from './Icons';
import { Modal, ModalHeader } from './Modal';
import { useLatest } from './usePresence';

type Of<K extends ModalState['kind']> = Extract<ModalState, { kind: K }>;

/** Toast action on confirmations that promise a reply: the address to write to. */
const copyContact = { label: 'Copy email', run: () => void copyWithToast(CONTACT_EMAIL, 'Email address copied') };

/** Keeps the last modal of `kind` around while its exit animation runs. */
function useModalOf<K extends ModalState['kind']>(kind: K): { open: boolean; m: Of<K> | null } {
  const modal = useStore((s) => s.modal);
  const current = modal?.kind === kind ? (modal as Of<K>) : null;
  const m = useLatest(current);
  return { open: current != null, m };
}

/* ------------------------------------------------------------------ DEMO explainer */

export function DemoExplainer() {
  const { open } = useModalOf('demo');
  const closeModal = useStore((s) => s.closeModal);
  const h = useId();
  // never on real money: the chip that opens it is DEVNET or nothing there, and this is the second guard
  if (IS_REAL) return null;
  return (
    <Modal open={open} onClose={closeModal} labelledBy={h} width={420}>
      <ModalHeader onClose={closeModal} />
      <h2 id={h}>This is a demo</h2>
      <p className="dlg-sub">
        Prices, trades, launches and claims are simulated. No real transaction is ever sent and you're never asked to sign anything. Real
        shops on the map are real Google places; the seeded coins are fictional.
      </p>
      <footer className="dlg-f">
        <span className="dlg-f-spacer" />
        <Button variant="primary" onClick={closeModal} data-autofocus>
          Got it
        </Button>
      </footer>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Devnet explainer (real mode) */

export function NetworkExplainer() {
  const { open } = useModalOf('network');
  const closeModal = useStore((s) => s.closeModal);
  const h = useId();
  if (!IS_REAL || CLUSTER !== 'devnet') return null;
  return (
    <Modal open={open} onClose={closeModal} labelledBy={h} width={420}>
      <ModalHeader onClose={closeModal} />
      <h2 id={h}>You're on Solana devnet</h2>
      <p className="dlg-sub">Coins and SOL here are test tokens with no value. Use a wallet set to Devnet.</p>
      <div className="cl-opts net-rows">
        <OptionCard
          kind="button"
          chevron
          icon="water_drop"
          title="Get test SOL"
          sub="Free devnet SOL for launching and trading."
          onSelect={() => {
            closeModal();
            void getTestSol();
          }}
        />
        <div className="net-row" role="note">
          <span className="oi">
            <Icon name="settings" />
          </span>
          <span>
            <b>Switch Phantom to Devnet</b>
            <small>Settings → Developer settings → Testnet mode</small>
          </span>
        </div>
        <OptionCard
          kind="button"
          chevron
          icon="science"
          title="Open the demo"
          sub="Simulated coins and prices, no wallet needed."
          onSelect={() => {
            location.assign('/?mode=demo');
          }}
        />
      </div>
      <footer className="dlg-f">
        <Button variant="text" icon="open_in_new" onClick={() => openExternal(FAUCET_URL)}>
          faucet.solana.com
        </Button>
        <span className="dlg-f-spacer" />
        <Button variant="primary" onClick={closeModal} data-autofocus>
          Got it
        </Button>
      </footer>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Report */

const REASONS: { key: ReportReason; label: string; icon: string }[] = [
  { key: 'impersonation', label: 'Pretends to be the business', icon: 'storefront' },
  { key: 'offensive', label: 'Offensive name or art', icon: 'flag' },
  { key: 'scam', label: 'Scam or misleading', icon: 'warning' },
  { key: 'other', label: 'Something else', icon: 'help' },
];

export function ReportSheet() {
  const { open, m } = useModalOf('report');
  const closeModal = useStore((s) => s.closeModal);
  const toast = useStore((s) => s.toast);
  const coin = useStore((s) => (m?.placeId ? s.coins[m.placeId] : undefined));
  const h = useId();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [coinRef, setCoinRef] = useState('');
  const [refTouched, setRefTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason(m?.reason ?? null);
      setDetails('');
      setCoinRef('');
      setRefTouched(false);
      setErr(null);
    }
  }, [open, m]);

  // Help → "Report a coin" has no coin selected: ask which one (Phase-1 minor #5)
  const needsRef = !m?.placeId;
  const refMint = needsRef ? mintFromCoinRef(coinRef) : null;
  const refErr = needsRef && refTouched && !refMint ? (coinRef.trim() ? "That isn't a coin link or mint address" : 'Paste the coin link or mint') : null;

  const send = async () => {
    setRefTouched(true);
    if (!reason || (needsRef && !refMint) || sending) return;
    if (IS_REAL) {
      setSending(true);
      setErr(null);
      try {
        await api.report({
          kind: 'report',
          ...(m?.placeId ? { placeId: m.placeId } : {}),
          ...(coin?.mint || refMint ? { mint: coin?.mint ?? refMint ?? undefined } : {}),
          reason,
          ...(details.trim() ? { details: details.trim().slice(0, 1000) } : {}),
        });
      } catch (e) {
        setSending(false);
        setErr(apiErrorMessage(e, "We couldn't send that. Try again."));
        return;
      }
      setSending(false);
    }
    closeModal();
    toast(`Thanks — we'll review it. To follow up, email ${CONTACT_EMAIL}`, 'ok', copyContact);
  };

  return (
    <Modal open={open} onClose={closeModal} labelledBy={h} busy={sending}>
      <ModalHeader onClose={closeModal} closeDisabled={sending} />
      <h2 id={h}>Report this coin</h2>
      {needsRef ? (
        <TextField
          label="Coin link or mint"
          value={coinRef}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => setCoinRef(e.target.value)}
          onBlur={() => setRefTouched(true)}
          error={refErr}
          translate="no"
          data-autofocus
        />
      ) : null}
      <OptionGroup label="Reason" className="opt-list">
        {REASONS.map((r) => (
          <OptionCard key={r.key} icon={r.icon} title={r.label} checked={reason === r.key} onSelect={() => setReason(r.key)} />
        ))}
      </OptionGroup>
      <TextArea label="Details (optional)" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={500} rows={3} />
      {err ? (
        <p className="tf-help err" role="alert">
          {err}
        </p>
      ) : null}
      <footer className="dlg-f">
        <span className="dlg-f-spacer" />
        <Button variant="text" onClick={closeModal} disabled={sending}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void send()} disabled={!reason || sending || (needsRef && refTouched && !refMint)} loading={sending}>
          Send report
        </Button>
      </footer>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Business opt-out */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function OptOutSheet() {
  const { open, m } = useModalOf('optout');
  const closeModal = useStore((s) => s.closeModal);
  const openModal = useStore((s) => s.openModal);
  const focusSearch = useStore((s) => s.focusSearch);
  const toast = useStore((s) => s.toast);
  const h = useId();
  const [form, setForm] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(false);
      setName('');
      setEmail('');
      setNote('');
      setTouched(false);
    }
  }, [open]);

  const nameErr = touched && !name.trim() ? 'Add your name' : null;
  const emailErr = touched && !EMAIL_RE.test(email.trim()) ? 'Use an email at your business domain' : null;

  // From Help or the drawer there is no shop selected: help them find it first (its page's opt-out link has the place).
  const noShop = !m?.placeId;
  const findShop = () => {
    closeModal();
    focusSearch({ tip: true });
  };
  const claim = () => {
    if (m?.placeId) openModal({ kind: 'claim', placeId: m.placeId });
    else findShop();
  };

  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setTouched(true);
    if (!name.trim() || !EMAIL_RE.test(email.trim()) || sending) return;
    if (IS_REAL) {
      setSending(true);
      setErr(null);
      try {
        const coin = m?.placeId ? useStore.getState().coins[m.placeId] : undefined;
        await api.report({
          kind: 'optout',
          ...(m?.placeId ? { placeId: m.placeId } : {}),
          ...(coin ? { mint: coin.mint } : {}),
          reason: 'optout',
          details: `Name: ${name.trim()}${note.trim() ? `\n${note.trim()}` : ''}`.slice(0, 1000),
          contact: email.trim().slice(0, 200),
        });
      } catch (e) {
        setSending(false);
        setErr(apiErrorMessage(e, "We couldn't send that. Try again."));
        return;
      }
      setSending(false);
    }
    closeModal();
    toast(`Request sent. We'll reply within 3 days from ${CONTACT_EMAIL}`, 'ok', copyContact);
  };

  return (
    <Modal open={open} onClose={closeModal} labelledBy={h}>
      <ModalHeader
        onClose={closeModal}
        lead={
          form ? (
            <Button variant="text" icon="arrow_back" onClick={() => setForm(false)}>
              Back
            </Button>
          ) : undefined
        }
      />
      <h2 id={h}>Own this business?</h2>
      <p className="dlg-sub">
        {noShop
          ? 'You can claim the fees, or ask us to hide coins for your business. Find your shop first: search for it, then use Business opt-out on its page.'
          : 'You can claim the fees, or ask us to hide coins for your business.'}
      </p>
      {form ? (
        <div className="dlg-step" key="form">
          <TextField label="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" error={nameErr} data-autofocus />
          <TextField
            label="Email at your business domain"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            error={emailErr}
          />
          <TextArea label="Anything we should know" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} />
          {err ? (
            <p className="tf-help err" role="alert">
              {err}
            </p>
          ) : null}
          <footer className="dlg-f">
            <span className="dlg-f-spacer" />
            <Button variant="primary" onClick={() => void send()} loading={sending}>
              Send request
            </Button>
          </footer>
        </div>
      ) : (
        <footer className="dlg-f">
          <span className="dlg-f-spacer" />
          <Button variant="outline" onClick={noShop ? findShop : () => setForm(true)}>
            Ask us to hide it
          </Button>
          <Button variant="primary" icon="verified" onClick={claim}>
            Claim the fees
          </Button>
        </footer>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ Lightbox */

export function Lightbox() {
  const { open, m } = useModalOf('lightbox');
  const closeModal = useStore((s) => s.closeModal);
  if (!m) return null;
  return (
    <Modal open={open} onClose={closeModal} ariaLabel={m.alt} className="lightbox" scrimClassName="scrim-dark" noHandle>
      <IconButton icon="close" label="Close" className="lightbox-x" onClick={closeModal} />
      <img src={m.src} alt={m.alt} />
      {m.credit ? <p className="lightbox-credit">{m.credit}</p> : null}
    </Modal>
  );
}

/** All shared sheets; mounted once by App. */
export function SharedModals() {
  return (
    <>
      <DemoExplainer />
      <NetworkExplainer />
      <ReportSheet />
      <OptOutSheet />
      <Lightbox />
      <ConsentGate />
    </>
  );
}
