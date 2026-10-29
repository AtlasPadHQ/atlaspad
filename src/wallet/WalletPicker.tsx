/**
 * Wallet list + "Continue with email" (DESIGN §12.4), used by the wallet modal and embedded in
 * the launch modal (step 2 "Sign in to launch") and the claim modal (step 3 "Sign in to get paid").
 *
 * Connect only: rows call solanaWallets.connectWallet (standard:connect). The email path mocks a
 * Privy-style embedded wallet (demo code 271 604) and creates a deterministic base58 address.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DEMO_EMAIL_CODE, RESEND_COOLDOWN_S, links } from '../config';
import { countdown } from '../lib/format';
import { connectedToast, useStore } from '../store';
import { CLUSTER, IS_REAL } from '../mode';
import type { WalletInfo } from '../types';
import { Button, CodeInput, Icon, Spinner, TextField } from '../ui';
import {
  connectWallet,
  createEmailWallet,
  disconnect,
  extraWalletsLoading,
  isEmailLike,
  listWallets,
  loadExtraWallets,
  onExtraWalletsLoading,
  maskEmail,
  subscribeWallets,
  walletErrorMessage,
} from './solanaWallets';
import { emailLoginAvailable } from './emailLogin';
import { PINNED_WALLET_ICONS } from './walletIcons';
import './wallet.css';

export interface WalletPickerProps {
  /** List-screen heading, e.g. "Connect" / "Sign in to launch". */
  title: string;
  sub: string;
  /** id for the visible h2 (the modal's aria-labelledby). */
  headingId: string;
  /** Called after the store holds the newly connected wallet. */
  onConnected: (address: string) => void;
  /** Error line above the list (e.g. "Your wallet disconnected. Sign in again to continue."). */
  notice?: string | null;
  /** Show the Terms / Privacy footer (wallet modal). */
  terms?: boolean;
}

type Screen = 'list' | 'email' | 'code';

/**
 * Re-list wallets when they register / unregister (and once shortly after mount for late injectors). Opening a list
 * also loads the wallets this app registers on demand (devnet test wallet); `loading` is true meanwhile.
 */
function useWalletList(): { wallets: WalletInfo[]; loading: boolean } {
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(() => extraWalletsLoading());
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const off = subscribeWallets(bump);
    const offLoading = onExtraWalletsLoading(() => {
      setLoading(extraWalletsLoading());
      bump();
    });
    void loadExtraWallets();
    setLoading(extraWalletsLoading());
    const t = setTimeout(bump, 600);
    return () => {
      off();
      offLoading();
      clearTimeout(t);
    };
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wallets = useMemo(() => listWallets(), [version]);
  return { wallets, loading };
}

export function WalletIcon({ info, size = 32 }: { info: Pick<WalletInfo, 'name' | 'icon'>; size?: number }) {
  // detected wallets bring their own icon; pinned ones that aren't installed use their brand icon
  const src = info.icon || PINNED_WALLET_ICONS[info.name];
  if (src) return <img className="wicon" src={src} alt="" width={size} height={size} draggable={false} />;
  return (
    <span className="wicon letter" aria-hidden="true" style={{ width: size, height: size }}>
      {info.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function WalletPicker({ title, sub, headingId, onConnected, notice, terms }: WalletPickerProps) {
  const { wallets, loading: walletsLoading } = useWalletList();
  // Real mode hides "Continue with email": the email screens are the demo's mock and no Privy adapter
  // exists yet, so PRIVY_APP_ID alone never shows it (./emailLogin, INTEGRATION.md §1.9).
  const privy = useStore((s) => !!s.chain.config?.features.privy);
  const emailEnabled = emailLoginAvailable(IS_REAL, privy);
  const [screen, setScreen] = useState<Screen>('list');
  const [connecting, setConnecting] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ name: string; msg: string } | null>(null);
  const alive = useRef(true);
  const rootRef = useRef<HTMLDivElement>(null);

  // email flow
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      timers.current.forEach((t) => clearTimeout(t));
      timers.current = [];
    };
  }, []);

  // resend cooldown ticker
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // move focus to the new screen's first field / heading
  const firstScreen = useRef(true);
  useEffect(() => {
    if (firstScreen.current) {
      firstScreen.current = false;
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)') ?? root.querySelector<HTMLElement>('h2');
    target?.focus({ preventScroll: true });
  }, [screen]);

  const later = (fn: () => void, ms: number) => {
    const t = window.setTimeout(() => {
      timers.current = timers.current.filter((x) => x !== t);
      if (alive.current) fn();
    }, ms);
    timers.current.push(t);
  };

  const connect = async (w: WalletInfo) => {
    if (connecting) return;
    const st = useStore.getState();
    setRowError(null);
    setConnecting(w.name);
    st.setWalletConnecting(w.name);
    try {
      const r = await connectWallet(w.name);
      useStore.getState().setWallet({ address: r.address, kind: 'standard', walletName: r.walletName, icon: r.icon });
      useStore.getState().toast(connectedToast(r.address), 'ok');
      if (alive.current) setConnecting(null);
      onConnected(r.address);
    } catch (err) {
      useStore.getState().setWalletConnecting(null);
      if (!alive.current) return;
      setConnecting(null);
      setRowError({ name: w.name, msg: walletErrorMessage(err, w.name) });
    }
  };

  const emailError = emailTouched && !isEmailLike(email) ? 'Enter a valid email address' : null;

  const sendCode = () => {
    setEmailTouched(true);
    if (!isEmailLike(email) || sending) return;
    setSending(true);
    later(() => {
      setSending(false);
      setCode('');
      setCodeErr(false);
      setCooldown(RESEND_COOLDOWN_S);
      setScreen('code');
    }, 700);
  };

  const resend = () => {
    if (cooldown > 0) return;
    setCode('');
    setCodeErr(false);
    setCooldown(RESEND_COOLDOWN_S);
    useStore.getState().toast(`We sent a new code to ${maskEmail(email)}`);
  };

  const verify = (digits = code) => {
    if (digits.length < 6 || checking) return;
    setChecking(true);
    later(async () => {
      if (digits !== DEMO_EMAIL_CODE) {
        setChecking(false);
        setCode(''); // retype from the first box (focus returns there, see CodeInput)
        setCodeErr(true);
        setAttempt((a) => a + 1);
        return;
      }
      // switching from a browser wallet to the embedded one: drop the standard session first
      await disconnect();
      const clean = email.trim();
      const { address } = createEmailWallet(clean);
      const st = useStore.getState();
      st.setWallet({ address, kind: 'email', walletName: 'Email', email: clean });
      st.toast(connectedToast(address), 'ok');
      if (alive.current) setChecking(false);
      onConnected(address);
    }, 600);
  };

  if (screen === 'email' || screen === 'code') {
    return (
      <div ref={rootRef} className="wpick">
        <Button variant="text" icon="arrow_back" className="wp-back" onClick={() => setScreen(screen === 'code' ? 'email' : 'list')}>
          Back
        </Button>
        <h2 id={headingId} tabIndex={-1}>
          Continue with email
        </h2>
        {screen === 'email' ? (
          <form
            className="wp-form"
            onSubmit={(e) => {
              e.preventDefault();
              sendCode();
            }}
            noValidate
          >
            <TextField
              label="Email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setEmailTouched(!!email)}
              error={emailError}
              data-autofocus
            />
            <Button type="submit" variant="primary" block className="wp-primary" loading={sending}>
              Send code
            </Button>
          </form>
        ) : (
          <div className="wp-form">
            <p className="dlg-sub">We sent a 6-digit code to {maskEmail(email)}</p>
            <div className="dlg-box">
              <Icon name="info" />
              <div>
                <b>Demo code: 271 604</b>
                <small>No email is sent in the demo.</small>
              </div>
            </div>
            <CodeInput
              value={code}
              onChange={(v) => {
                setCode(v);
                if (codeErr) setCodeErr(false);
              }}
              onComplete={(v) => verify(v)}
              error={codeErr}
              shakeKey={attempt}
              disabled={checking}
              autoFocus
            />
            {codeErr ? (
              <p className="tf-help err wp-center" role="alert">
                That code didn't match.
              </p>
            ) : null}
            <div className="wp-center">
              <Button variant="text" disabled={cooldown > 0} onClick={resend}>
                {cooldown > 0 ? `Resend in ${countdown(cooldown)}` : 'Resend'}
              </Button>
            </div>
            <Button variant="primary" block className="wp-primary" disabled={code.length < 6} loading={checking} onClick={() => verify()}>
              {checking ? 'Checking…' : 'Verify'}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="wpick">
      <h2 id={headingId} tabIndex={-1}>
        {title}
      </h2>
      <p className="dlg-sub">{sub}</p>
      {notice ? (
        <p className="tf-help err wp-notice" role="alert">
          {notice}
        </p>
      ) : null}
      <ul className="wlist" aria-busy={walletsLoading || undefined}>
        {walletsLoading ? (
          <li key="loading-extra">
            <span className="wrow is-loading" aria-live="polite">
              <span className="wicon letter" aria-hidden="true" style={{ width: 32, height: 32 }}>
                <Spinner size={16} />
              </span>
              <span className="wname">Loading wallets…</span>
            </span>
          </li>
        ) : null}
        {wallets.map((w) => {
          const busy = connecting === w.name;
          const err = rowError?.name === w.name ? rowError.msg : null;
          if (!w.installed) {
            const href = w.openInAppUrl ?? w.installUrl;
            const label = w.openInAppUrl ? 'Open in app' : 'Install';
            return (
              <li key={w.name}>
                <a
                  className={['wrow', connecting ? 'is-off' : ''].filter(Boolean).join(' ')}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${label} ${w.name} (opens in a new tab)`}
                >
                  <WalletIcon info={w} />
                  <span className="wname">{w.name}</span>
                  <span className="wrow-act">
                    {label}
                    <Icon name="open_in_new" size={18} />
                  </span>
                </a>
              </li>
            );
          }
          return (
            <li key={w.name}>
              <button
                type="button"
                className="wrow"
                disabled={!!connecting && !busy}
                aria-busy={busy || undefined}
                aria-describedby={err ? `werr-${w.name}` : undefined}
                onClick={() => void connect(w)}
              >
                <WalletIcon info={w} />
                <span className="wname">{w.name}</span>
                {busy ? (
                  <span className="wtrail">
                    <Spinner size={16} />
                    Approve in {w.name}…
                  </span>
                ) : (
                  <span className="wtrail">Detected</span>
                )}
              </button>
              {err ? (
                <p id={`werr-${w.name}`} className="tf-help err wrow-err" role="alert">
                  {err}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {emailEnabled ? (
        <>
          <div className="wor" aria-hidden="true">
            <span>or</span>
          </div>
          <Button variant="outline" block icon="mail" disabled={!!connecting} onClick={() => setScreen('email')}>
            Continue with email
          </Button>
        </>
      ) : wallets.length === 0 || wallets.every((w) => !w.installed) ? (
        <p className="tf-help wp-center">Install a Solana wallet to continue. Email sign-in isn't available yet.</p>
      ) : null}
      {terms ? (
        <p className="wterms">
          By continuing you agree to the{' '}
          <a className="hit" href={links.terms} target="_blank" rel="noopener noreferrer">
            Terms
          </a>{' '}
          and{' '}
          <a className="hit" href={links.privacy} target="_blank" rel="noopener noreferrer">
            Privacy Policy
          </a>
          .{' '}
          {IS_REAL
            ? CLUSTER === 'devnet'
              ? 'Devnet: your wallet signs test transactions only.'
              : 'Your wallet asks you to approve every transaction.'
            : 'We never ask you to sign anything in the demo.'}
        </p>
      ) : null}
    </div>
  );
}
