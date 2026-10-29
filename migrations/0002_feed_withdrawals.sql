-- Live feed payouts (INTEGRATION §3.2 /api/feed): withdrawals are read from the program monitor's `Withdrawn` events.
CREATE INDEX IF NOT EXISTS chain_events_kind_ts ON chain_events(kind, ts DESC);

-- What the trader actually paid (buy) / received (sell) in lamports, fees included (curve: sol_amount ± protocol fee ±
-- creator fee from the TradeEvent; AMM: user_quote_amount_in / _out). NULL on rows indexed before this column existed:
-- the indexer backfills them from their transactions (job `trade_amounts`).
ALTER TABLE trades ADD COLUMN user_lamports INTEGER;
