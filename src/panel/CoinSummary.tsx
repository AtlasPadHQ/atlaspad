/**
 * Coin summary (DESIGN §8.10): price + 24h change, timeframe toggle 1H / 24H / 7D / All that
 * really changes the chart range, scrubbable sparkline, 2×2 stats. Plus the mobile `.chart-card`.
 */
import { useMemo, useState } from 'react';
import { CHART_RANGES, seriesFor, type ChartRange } from '../lib/market';
import { curvePct, holders, pct, solPrice, time24, usdCompact, usdFull, usdOwed, usdPrice } from '../lib/format';
import type { Coin } from '../types';
import { Change, Seg, useTickFlash } from '../ui';
import { useUsdFresh } from '../realdata/hooks';
import { u64 } from '../realdata/units';
import { Sparkline } from './Sparkline';
import { useNow } from './util';

const RANGE_OPTIONS = CHART_RANGES.map((r) => ({ value: r.key, label: r.label, ariaLabel: r.sub }));

export function CoinSummary({ coin, sparkHeight = 84, className }: { coin: Coin; sparkHeight?: number; className?: string }) {
  const [range, setRange] = useState<ChartRange>('24h');
  const [scrub, setScrub] = useState<number | null>(null);
  const now = useNow(30_000);
  const series = useMemo(() => seriesFor(coin, range, now), [coin, range, now]);
  const meta = CHART_RANGES.find((r) => r.key === range) ?? CHART_RANGES[1];
  const change = range === '24h' ? coin.change24h : series.changePct;
  const flash = useTickFlash(coin.priceUsd);
  const usdOk = useUsdFresh() || !coin.real;

  const start = series.prices[0] ?? coin.priceUsd;
  const scrubPrice = scrub != null ? series.prices[scrub] : undefined;
  const scrubTime = scrub != null ? series.times[scrub] : undefined;
  const scrubChange = scrubPrice != null && start > 0 ? (scrubPrice / start - 1) * 100 : 0;
  const up = !(change < 0);

  return (
    <section className={['coin', className ?? ''].filter(Boolean).join(' ')} aria-label={`$${coin.ticker} price`}>
      <div className="coin-head">
        <div>
          <div className={['coin-price', scrub == null ? flash : ''].filter(Boolean).join(' ')} translate="no">
            {usdOk ? usdPrice(scrubPrice ?? coin.priceUsd) : `${solPrice(coin.priceSol)} SOL`}
          </div>
          <div className="coin-sub">
            {scrubPrice != null && scrubTime != null ? (
              <>
                <Change value={scrubChange} /> <span>· {time24(scrubTime)}</span>
              </>
            ) : range === '24h' && coin.real && !coin.real.change24hKnown ? (
              <span>— {meta.sub}</span>
            ) : (
              <>
                <Change value={change} /> <span>{meta.sub}</span>
              </>
            )}
          </div>
        </div>
        <Seg
          options={RANGE_OPTIONS}
          value={range}
          ariaLabel="Chart range"
          onChange={(v) => {
            setScrub(null);
            setRange(v);
          }}
        />
      </div>
      <Sparkline
        prices={series.prices}
        height={sparkHeight}
        up={up}
        onScrub={setScrub}
        ariaLabel={`Price chart, ${meta.sub}, ${up ? 'up' : 'down'} ${Math.abs(change).toFixed(1)}%`}
        valueText={(i) => `${usdPrice(series.prices[i] ?? coin.priceUsd)} at ${time24(series.times[i] ?? now)}`}
      />
      {coin.real && !coin.real.graduated ? (
        <p className="coin-curve" title="pump.fun bonding curve: at 100% the coin moves to PumpSwap">
          Bonding curve {curvePct(coin.real.progressPct)}
        </p>
      ) : coin.real?.graduated ? (
        <p className="coin-curve">Graduated · trading on PumpSwap</p>
      ) : null}
      <div className="stats">
        <div className="stat">
          <div className="k">Market cap</div>
          <div className="v">{usdCompact(coin.marketCapUsd)}</div>
        </div>
        <div className="stat">
          <div className="k">Volume 24h</div>
          <div className="v">{usdCompact(coin.volume24h)}</div>
        </div>
        <div className="stat" title={coin.real ? 'Updated hourly' : undefined}>
          <div className="k">Holders</div>
          <div className="v">{coin.real && !coin.real.holdersKnown ? '—' : holders(coin.holders)}</div>
        </div>
        <div className="stat">
          <div className="k">Fees earned</div>
          <div className="v amb">{coin.real ? usdOwed(coin.feesEarnedUsd, u64(coin.real.feesEarnedLamports) > 0n) : usdFull(coin.feesEarnedUsd)}</div>
        </div>
      </div>
    </section>
  );
}

/**
 * Mobile strip chart card (DESIGN §8.10): `$KEBAB · 24h`, price + change, 172×64 spark. Tap → Coin tab.
 * The spark is the Coin tab's 24H series (seriesFor), not the raw 48-bucket `history`: that array is
 * padded with the launch price before a young coin's launch, which drew a flat line + end spike.
 */
export function ChartCard({ coin, onOpen }: { coin: Coin; onOpen: () => void }) {
  const flash = useTickFlash(coin.priceUsd);
  const now = useNow(30_000);
  const series = useMemo(() => seriesFor(coin, '24h', now), [coin, now]);
  const up = !(coin.change24h < 0);
  return (
    <button
      type="button"
      className="chart-card"
      onClick={onOpen}
      aria-label={`$${coin.ticker} ${usdPrice(coin.priceUsd)}, ${pct(coin.change24h)} past 24h. Open the Coin tab`}
    >
      <span className="k" translate="no">
        ${coin.ticker} · 24h
      </span>
      <span className="v">
        <span className={flash}>{usdPrice(coin.priceUsd)}</span>
        <Change value={coin.change24h} />
      </span>
      <Sparkline prices={series.prices} height={64} up={up} dot={false} className="spark-mini" />
    </button>
  );
}
