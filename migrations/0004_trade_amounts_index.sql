-- The cron's `trade_amounts` backfill (worker/indexer.ts) looks for trades whose user_lamports is still NULL. Without an
-- index that is a full scan of `trades` on every run, and D1 bills every row it reads (Workers Free: 5,000,000 a day for
-- the whole account). Only rows indexed before migration 0002 are NULL and new trades never are, so this partial index
-- is (nearly) empty: the backfill becomes an index lookup that reads only the rows it will fix.
CREATE INDEX IF NOT EXISTS trades_user_lamports_missing ON trades(sig, ts) WHERE user_lamports IS NULL;
