// Help on a mainnet build states a realistic launch cost and what a failed transaction costs, and every build tells owners
// to tap Claim, the action their shop shows (SSR, no DOM).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../mode', async (importOriginal) => ({ ...(await importOriginal<typeof import('../mode')>()), BUILD_CLUSTER: 'mainnet', APP_MODE: 'real', IS_REAL: true, CLUSTER: 'mainnet' }));

import { useStore } from '../store';
import { CLAIM_HOW, HelpPanel, LAUNCH_COST_COPY } from './HelpPanel';

describe('Help (mainnet)', () => {
  it('launch cost: about 0.02 SOL of network fees + rent, plus the optional first buy; failures still pay the fee', () => {
    expect(LAUNCH_COST_COPY).toMatch(/about 0\.02 SOL in network fees and rent/);
    expect(LAUNCH_COST_COPY).toMatch(/plus any first buy you choose/);
    expect(LAUNCH_COST_COPY).toMatch(/fails on Solana still pays its network fee/);
    const html = renderToStaticMarkup(createElement(HelpPanel));
    expect(html).toContain('about 0.02 SOL in network fees and rent');
    expect(html).toContain('still pays its network fee');
    expect(html).not.toContain('about 0.01 SOL');
    expect(html).toContain('real Solana transactions'); // the mainnet "Is this real money?" row
  });

  it("links AtlasPad's X account in a new tab", () => {
    const html = renderToStaticMarkup(createElement(HelpPanel));
    expect(html).toContain('href="https://x.com/AtlasPadx" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('@AtlasPadx on X');
  });

  it('links the public source code on GitHub in a new tab', () => {
    const html = renderToStaticMarkup(createElement(HelpPanel));
    expect(html).toContain('href="https://github.com/AtlasPadHQ/atlaspad" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('read the code on GitHub');
  });
});

describe('Help: how to start a claim', () => {
  it('mainnet, phone check on or off: "tap Claim", never the fees-card-only "I own this business"', () => {
    expect(CLAIM_HOW).toBe('Own the business? Open your shop and tap Claim.');
    try {
      for (const [phoneVerification, variant] of [
        ['call', 'We call the phone number on your Google listing'],
        [null, 'Phone check isn&#x27;t switched on yet'],
      ] as const) {
        const config = phoneVerification ? { features: { phoneVerification } } : null;
        useStore.setState({ chain: { status: config ? 'ready' : 'loading', config } as never });
        // server rendering reads zustand's initial state: copy the live state in first
        Object.assign(useStore.getInitialState(), useStore.getState());
        const html = renderToStaticMarkup(createElement(HelpPanel));
        expect(html).toContain(variant);
        expect(html).toContain(`<p>${CLAIM_HOW}</p>`);
        expect(html).not.toContain('I own this business');
      }
    } finally {
      useStore.setState({ chain: { status: 'loading', config: null } as never });
      Object.assign(useStore.getInitialState(), useStore.getState());
    }
  });

  it('demo build: the same line', async () => {
    vi.doUnmock('../mode');
    vi.resetModules();
    try {
      const { IS_REAL } = await import('../mode');
      const demo = await import('./HelpPanel');
      expect(IS_REAL).toBe(false);
      const html = renderToStaticMarkup(createElement(demo.HelpPanel));
      expect(html).toContain('This is a demo'); // the demo rows rendered
      expect(html).toContain(`<p>${demo.CLAIM_HOW}</p>`);
      expect(html).not.toContain('I own this business');
    } finally {
      vi.resetModules();
    }
  });
});
