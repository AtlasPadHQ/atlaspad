/**
 * A mainnet build says only what is true (SSR, no DOM): no DEMO chip or "simulated" explainer in the mobile menu,
 * no phone-call promises while phone verification is off (or before /api/config loaded), and a Business opt-out with
 * no shop selected sends the owner to find their shop instead of a request the Worker rejects.
 */
import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigResponse } from '../../worker/wire';

vi.mock('../mode', async (importOriginal) => ({ ...(await importOriginal<typeof import('../mode')>()), BUILD_CLUSTER: 'mainnet', APP_MODE: 'real', IS_REAL: true, CLUSTER: 'mainnet' }));
// Modal and the drawer portal to <body>, which server rendering can't do: render them inline
vi.mock('./Modal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./Modal')>()),
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? h('section', { role: 'dialog' }, children) : null),
  ModalHeader: () => null,
}));
vi.mock('react-dom', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-dom')>()), createPortal: (node: ReactNode) => node }));
// no clicks without a DOM: remember each text button's handler by its label
const { clicks } = vi.hoisted(() => ({ clicks: new Map<string, () => void>() }));
vi.mock('./Button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./Button')>();
  const Button = (props: import('./Button').ButtonProps) => {
    if (typeof props.children === 'string' && props.onClick) clicks.set(props.children, props.onClick as () => void);
    return h(actual.Button, props);
  };
  return { ...actual, Button };
});

import LaunchFlow from '../launch/LaunchFlow';
import { AboutCoin, Steps } from '../panel/Sections';
import Drawer from '../rail/Drawer';
import { coinFromDTO } from '../realdata/mapping';
import { coinDto } from '../realdata/testFixtures';
import { useStore } from '../store';
import type { Place } from '../types';
import { HelpPanel } from './HelpPanel';
import { DemoExplainer, OptOutSheet } from './SharedModals';

const ROOT = join(__dirname, '..', '..');
const place: Place = {
  id: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
  source: 'google',
  name: 'Kebab Junction',
  category: 'kebab',
  categoryLabel: 'Kebab shop',
  emoji: '🥙',
  address: 'Kingsland Rd, London',
  location: { lat: 51.548, lng: -0.075 },
};
const coin = coinFromDTO(coinDto(), { solUsd: 150, launchPriceLamports: 28 });

/** Server rendering reads zustand's initial state: copy the live state in first. Text only, entities decoded. */
function text(c: () => unknown): string {
  Object.assign(useStore.getInitialState(), useStore.getState());
  return renderToStaticMarkup(h(c as () => null))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function withPhone(phoneVerification: 'call' | 'screen' | 'none' | null) {
  const config = phoneVerification ? ({ features: { phoneVerification } } as unknown as ConfigResponse) : null;
  useStore.setState({ chain: { status: config ? 'ready' : 'loading', config } as never });
}

const PHONE = /phone|call/i;
const copy = {
  steps: () => text(() => h(Steps)),
  about: () => text(() => h(AboutCoin, { coin, owner: 'unclaimed' })),
  help: () => text(HelpPanel),
  launch: () => {
    useStore.setState({ modal: { kind: 'launch', place } });
    return text(LaunchFlow);
  },
};

beforeEach(() => {
  clicks.clear();
  useStore.setState({ modal: null, railOpen: false, searchFocus: null, coins: {}, wallet: { address: null, kind: null } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mainnet: no demo wording', () => {
  it('the mobile menu shows no DEMO chip (mainnet has no mode chip)', () => {
    vi.stubGlobal('document', { body: {} });
    useStore.setState({ railOpen: true });
    const t = text(Drawer);
    expect(t).toContain('Business opt-out'); // it did render
    expect(t).not.toMatch(/DEMO|simulated|DEVNET/);
  });

  it('the DEMO explainer renders nothing in real mode', () => {
    useStore.setState({ modal: { kind: 'demo' } });
    expect(text(DemoExplainer).trim()).toBe('');
  });
});

describe('mainnet: no phone promises while phone verification is off', () => {
  for (const [label, mode] of [
    ["phoneVerification 'none'", 'none'],
    ['before /api/config loaded', null],
  ] as const) {
    it(label, () => {
      withPhone(mode);
      const steps = copy.steps();
      expect(steps).toContain('website code');
      expect(steps).not.toMatch(PHONE);
      const about = copy.about();
      expect(about).toContain("Owners verify with a code on the shop's own website");
      expect(about).not.toMatch(PHONE);
      const help = copy.help();
      expect(help).toContain("Verify with a short code on your shop's own website");
      expect(help).not.toMatch(/We call|6-digit|help you verify/);
      expect(help).toContain("Verification for shops without their own website isn't available yet");
      const launch = copy.launch();
      expect(launch).toContain("The owner claims with a code on the shop's own website.");
      expect(launch).not.toMatch(/phone verification/i);
    });
  }

  it('phone verification on: the phone copy stays', () => {
    withPhone('call');
    expect(copy.steps()).toContain('phone check');
    expect(copy.about()).toContain('Owners verify by a phone call to the number on the Google listing');
    expect(copy.help()).toContain('We call the phone number on your Google listing');
    expect(copy.launch()).toContain('The owner claims by phone verification.');
  });
});

describe('Business opt-out with no shop selected (Help, mobile menu)', () => {
  it('"Ask us to hide it" closes the sheet and opens search with the tip, instead of a request without a place', () => {
    useStore.setState({ modal: { kind: 'optout' } });
    const t = text(OptOutSheet);
    expect(t).toContain('Find your shop first');
    const hide = clicks.get('Ask us to hide it');
    expect(hide).toBeTypeOf('function');
    hide?.();
    const s = useStore.getState();
    expect(s.modal).toBeNull();
    expect(s.searchFocus).toMatchObject({ tip: true });
  });

  it("from the shop's own page (placeId) it stays the request form", () => {
    useStore.setState({ modal: { kind: 'optout', placeId: place.id } });
    const t = text(OptOutSheet);
    expect(t).toContain('ask us to hide coins for your business');
    expect(t).not.toContain('Find your shop first');
  });
});

describe('copy promises', () => {
  it('nothing promises a notification for watched shops (none is ever sent)', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
      });
    const hits = files(join(ROOT, 'src')).filter((f) => /let you know/i.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });
});
