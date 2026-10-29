// "Continue with email" in real mode (INTEGRATION.md §1.9): the email screens are the demo's mock, so a mainnet build
// must not show them even when the Worker reports features.privy (PRIVY_APP_ID set). SSR render, no DOM.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigResponse } from '../../worker/wire';

vi.mock('../mode', async (importOriginal) => ({ ...(await importOriginal<typeof import('../mode')>()), BUILD_CLUSTER: 'mainnet', APP_MODE: 'real', IS_REAL: true, CLUSTER: 'mainnet' }));
// zustand's server snapshot is the initial state: read the live state synchronously instead (as components.test.ts)
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  const hook = ((sel: (s: ReturnType<typeof actual.useStore.getState>) => unknown) => sel(actual.useStore.getState())) as unknown as typeof actual.useStore;
  Object.assign(hook, actual.useStore);
  return { ...actual, useStore: hook };
});

import { useStore } from '../store';
import { emailLoginAvailable, PRIVY_ADAPTER_BUILT } from './emailLogin';
import { WalletPicker } from './WalletPicker';

function render(): string {
  return renderToStaticMarkup(createElement(WalletPicker, { title: 'Connect', sub: 'Pick a wallet', headingId: 'h', onConnected: () => {} }));
}

describe('email login gate', () => {
  it('no Privy adapter is built, so real mode never offers email; the demo keeps its mock', () => {
    expect(PRIVY_ADAPTER_BUILT).toBe(false);
    expect(emailLoginAvailable(true, true)).toBe(false); // mainnet/devnet with PRIVY_APP_ID set
    expect(emailLoginAvailable(true, false)).toBe(false);
    expect(emailLoginAvailable(false, false)).toBe(true); // demo
  });

  it('a mainnet build with features.privy = true renders no "Continue with email"', () => {
    const s = useStore.getState();
    useStore.setState({ chain: { ...s.chain, status: 'ready', config: { cluster: 'mainnet', features: { privy: true } } as unknown as ConfigResponse } });
    const html = render();
    expect(html).toContain('Connect');
    expect(html).not.toContain('Continue with email');
    expect(html).toContain("Email sign-in isn&#x27;t available yet");
  });
});
