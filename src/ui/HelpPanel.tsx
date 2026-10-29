/**
 * Help panel (DESIGN §12.6 "Help"): 4 expandable rows + contact + footer links. Opened from the rail,
 * the drawer, "Learn more", "How claiming works" (store.openHelp(section)). SHARED (src/ui).
 */
import { useEffect, useRef, useState } from 'react';
import { usePhoneOff } from '../claim/phoneOff';
import { links } from '../config';
import { CONTACT_EMAIL } from '../legal/contact';
import { CLUSTER, IS_REAL } from '../mode';
import { useStore } from '../store';
import type { HelpSection } from '../types';
import { Icon } from './Icons';

const DEMO_ROWS: { key: HelpSection; title: string; body: string[] }[] = [
  {
    key: 'launching',
    title: 'How launching works',
    body: [
      'Tap any shop on the map, or paste its Google Maps link, then press Launch. You pick the coin name, ticker and art.',
      "Each place can have one coin. The first launch wins, and the name and ticker can't be changed later.",
      "Anyone can launch a coin for any shop. Until the owner verifies, the coin isn't affiliated with the business.",
    ],
  },
  {
    key: 'fees',
    title: 'Where the fees go',
    body: [
      'Every trade pays a small creator fee. 100% of it is held for the shop. AtlasPad takes nothing.',
      "Until the owner claims, the fees wait in the shop's vault. You can see how much is waiting on every shop.",
    ],
  },
  {
    key: 'claiming',
    title: 'Claiming your shop',
    body: [
      'Own the business? Open your shop and tap "I own this business".',
      "We call the phone number on your Google listing and read out a 6-digit code. Enter it, choose the wallet that should get paid, and you're done.",
      "Can't take the call? You can verify with a code on your website, an email at your website's domain, or a manual review.",
      'The first payout has a 72-hour hold so a hijacked listing can be disputed before any money moves.',
    ],
  },
  {
    key: 'real',
    title: 'Is this real money?',
    body: [
      'Not yet. This is a demo: prices, trades, launches and claims are simulated, and no real transaction is ever sent.',
      "You're never asked to sign anything. Real shops on the map are real Google places; the seeded coins are fictional.",
    ],
  },
];

/**
 * What a launch costs on mainnet, rounded up: rent for the accounts it creates (mint with metadata, bonding curve and
 * its token account, VaultState, the vault top-up: about 0.011 SOL; about 0.004 SOL more with a first buy, for the
 * buyer's token account and pump's volume account) plus 3 signatures and priority (at most 0.0008 SOL). A failed tx
 * creates nothing, so it costs only its network fee.
 */
export const LAUNCH_COST_COPY =
  "A launch costs about 0.02 SOL in network fees and rent for the new coin's accounts, plus any first buy you choose. A transaction that fails on Solana still pays its network fee (usually well under 0.001 SOL), but nothing else.";

/** Real mode (INTEGRATION.md §7, MAINNET-CHECKLIST "pump.fun admin_cto and upgrade risk disclosure in Help"). */
const REAL_ROWS: { key: HelpSection; title: string; body: string[] }[] = [
  {
    key: 'launching',
    title: 'How launching works',
    body: [
      'Tap any open business on the map, or paste its Google Maps link, then press Launch. You pick the coin name, ticker and art; your wallet signs.',
      LAUNCH_COST_COPY,
      "Each place can have one coin, enforced on Solana: the first launch wins, and the name and ticker can't be changed later.",
      "Anyone can launch a coin for any shop. Until the owner verifies, the coin isn't affiliated with the business.",
    ],
  },
  {
    key: 'fees',
    title: 'Where the fees go',
    body: [
      "Coins trade on pump.fun. Every trade pays pump.fun's creator fee (0.30% on the bonding curve, a tiered rate after graduation). 100% of creator fees are held in the shop's vault on Solana for its verified owner. AtlasPad takes nothing; pump.fun's own fees still apply.",
      'Only the verified owner can withdraw from the vault. AtlasPad decides who becomes the owner: our attestor approves verified claims, our guardian and governance keys can cancel a claim during its public window, and a multisig we control can upgrade the vault program. The Terms explain it in full.',
      "Risks: pump.fun can change its programs, and its admins can redirect future creator fees of any coin. We watch for this and alert, but it isn't in our control. Coins are volatile; only trade what you can afford to lose.",
    ],
  },
  {
    key: 'claiming',
    title: 'Claiming your shop',
    body: [
      'Own the business? Open your shop and tap "I own this business".',
      'We call the phone number on your Google listing and read out a 6-digit code. Enter it, then your wallet signs a claim. Only the owner wallet can withdraw.',
      `Every claim has a public window (72 hours) before you can withdraw, so a hijacked listing can be disputed before any money moves. To dispute a claim, email ${CONTACT_EMAIL}.`,
    ],
  },
  {
    key: 'real',
    title: 'Is this real money?',
    body: [
      CLUSTER === 'devnet'
        ? "Not here. This is Solana devnet: coins and SOL are test tokens with no value. Set your wallet to Devnet (Phantom: Settings → Developer settings → Testnet mode) and get free test SOL from the DEVNET chip."
        : 'Yes. Launches, trades, claims and withdrawals are real Solana transactions. Your wallet asks you to approve each one.',
      'Real shops on the map are real Google places. Coins are launched by the public and are not affiliated with the business unless the owner verifies.',
    ],
  },
];

const ROWS = IS_REAL ? REAL_ROWS : DEMO_ROWS;

/** Real mode while phone verification is off (/api/config phoneVerification 'none', or no config yet on mainnet). */
const CLAIMING_NO_PHONE: string[] = [
  'Own the business? Open your shop and tap "I own this business".',
  "Phone check isn't switched on yet. Verify with a short code on your shop's own website (we check it automatically), then your wallet signs a claim. Only the owner wallet can withdraw.",
  `No website of your own? Verification for shops without their own website isn't available yet. Email ${CONTACT_EMAIL} and we'll tell you when it is; your shop's fees stay safe in its vault.`,
  `Every claim has a public window (72 hours) before you can withdraw, so a hijacked listing can be disputed before any money moves. To dispute a claim, email ${CONTACT_EMAIL}.`,
];

export function HelpPanel() {
  const section = useStore((s) => s.helpSection);
  const openModal = useStore((s) => s.openModal);
  const phoneOff = usePhoneOff();
  const rows = phoneOff ? ROWS.map((r) => (r.key === 'claiming' ? { ...r, body: CLAIMING_NO_PHONE } : r)) : ROWS;
  const [openKeys, setOpenKeys] = useState<Set<HelpSection>>(() => new Set(section ? [section] : []));
  const rowRefs = useRef<Partial<Record<HelpSection, HTMLDivElement | null>>>({});

  useEffect(() => {
    if (!section) return;
    setOpenKeys((prev) => new Set([...prev, section]));
    const el = rowRefs.current[section];
    requestAnimationFrame(() => el?.scrollIntoView({ block: 'start', behavior: 'auto' }));
  }, [section]);

  const toggle = (k: HelpSection) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="help">
      <div className="lp-h" data-sheet-drag>
        <h1>Help</h1>
      </div>
      <div className="help-rows">
        {rows.map((r) => {
          const open = openKeys.has(r.key);
          const id = `help-${r.key}`;
          return (
            <div
              key={r.key}
              className={['help-row', open ? 'open' : ''].filter(Boolean).join(' ')}
              ref={(el) => {
                rowRefs.current[r.key] = el;
              }}
            >
              <button type="button" className="help-q" aria-expanded={open} aria-controls={id} onClick={() => toggle(r.key)}>
                <span>{r.title}</span>
                <Icon name="expand_more" className="help-chev" />
              </button>
              <div id={id} className="help-a" hidden={!open}>
                {r.body.map((p) => (
                  <p key={p}>{p}</p>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="foot help-legal">
        <p>Coins on AtlasPad are launched by the public and are not affiliated with the business.</p>
        <p>
          Questions, disputes or takedowns: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>
        <p>
          News and updates:{' '}
          <a href={links.xProfile} target="_blank" rel="noopener noreferrer">
            {links.xHandle} on X
          </a>
        </p>
        <p>
          AtlasPad is open source:{' '}
          <a href={links.github} target="_blank" rel="noopener noreferrer">
            read the code on GitHub
          </a>
        </p>
        <p>
          Own a shop with a coin you didn't ask for?{' '}
          <button type="button" className="link-btn" onClick={() => openModal({ kind: 'optout' })}>
            Business opt-out
          </button>
          {' · '}
          <button type="button" className="link-btn" onClick={() => openModal({ kind: 'report' })}>
            Report a coin
          </button>
        </p>
      </div>
      <div className="foot help-foot">
        <a href={links.terms} target="_blank" rel="noopener noreferrer">
          Terms
        </a>
        {' · '}
        <a href={links.privacy} target="_blank" rel="noopener noreferrer">
          Privacy
        </a>
        {' · '}
        <a href={links.googleMapsTerms} target="_blank" rel="noopener noreferrer">
          Google Maps Terms
        </a>
        {' · '}
        <a href={links.googlePrivacy} target="_blank" rel="noopener noreferrer">
          Google Privacy
        </a>
      </div>
    </div>
  );
}
