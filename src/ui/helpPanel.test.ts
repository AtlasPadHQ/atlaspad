// Help on a mainnet build states a realistic launch cost and what a failed transaction costs (SSR, no DOM).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../mode', async (importOriginal) => ({ ...(await importOriginal<typeof import('../mode')>()), BUILD_CLUSTER: 'mainnet', APP_MODE: 'real', IS_REAL: true, CLUSTER: 'mainnet' }));

import { HelpPanel, LAUNCH_COST_COPY } from './HelpPanel';

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
