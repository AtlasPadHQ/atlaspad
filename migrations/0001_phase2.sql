-- CORNERSHOP Phase 2 schema (INTEGRATION.md §2). One database per cluster: cornershop-devnet / cornershop-mainnet.
-- Apply: npx wrangler d1 migrations apply cornershop-devnet --env devnet --remote   (--local for wrangler dev)
-- Rules: raw IPs, phone numbers and codes are never stored (HMACs only). Google content is never stored; place ids and
-- coordinates (≤ 30 days, refreshed by the cron) are the only Google-derived values (ToS). u64 values are INTEGER
-- (every real value is < 2^53).

-- Content-addressed coin art + metadata JSON (served at /img/:id.:ext and /meta/:id.json).
CREATE TABLE assets (
  id TEXT PRIMARY KEY,                                     -- hex(sha256(bytes))[0..32]
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  bytes BLOB NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
  created_at INTEGER NOT NULL, ip_hash TEXT
);
CREATE TABLE metadata (
  id TEXT PRIMARY KEY,                                     -- hex(sha256(json))[0..32]
  json TEXT NOT NULL, name TEXT NOT NULL, symbol TEXT NOT NULL, description TEXT NOT NULL,
  image_id TEXT NOT NULL REFERENCES assets(id), place_id TEXT NOT NULL,
  used_by_mint TEXT, created_at INTEGER NOT NULL, ip_hash TEXT
);

-- Registry: one official coin per Google place (mirrors on-chain VaultState; the chain is the source of truth).
CREATE TABLE coins (
  place_id            TEXT PRIMARY KEY,                    -- canonical Google place.id (or devnet 'cornershop-test:*')
  place_hash          TEXT NOT NULL UNIQUE,                -- hex sha256(utf8(place_id)) = vault seed
  mint                TEXT NOT NULL UNIQUE,
  vault               TEXT NOT NULL,
  vault_state         TEXT NOT NULL,
  bonding_curve       TEXT NOT NULL,
  ticker              TEXT NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  category            TEXT NOT NULL,
  emoji               TEXT NOT NULL,
  bg                  TEXT NOT NULL,
  image_id            TEXT REFERENCES assets(id),
  metadata_id         TEXT NOT NULL REFERENCES metadata(id),
  launcher            TEXT NOT NULL,
  created_at          INTEGER NOT NULL,                    -- ms, block time of the launch tx
  launch_sig          TEXT NOT NULL UNIQUE,
  launch_slot         INTEGER NOT NULL,
  cluster             TEXT NOT NULL CHECK (cluster IN ('devnet','mainnet')),
  lat REAL, lng REAL, coords_expire_at INTEGER,           -- Google ToS: ≤ 30 days, refreshed by cron
  status              TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','hidden')),  -- moderation (UI only)
  graduated           INTEGER NOT NULL DEFAULT 0,
  pool TEXT, pool_base_vault TEXT, pool_quote_vault TEXT,
  -- market mirror (indexer; u64 as INTEGER, all < 2^53)
  v_sol INTEGER, v_tok INTEGER, real_sol INTEGER, real_tok INTEGER, supply INTEGER,
  complete            INTEGER NOT NULL DEFAULT 0,          -- curve.complete (graduation pending until the pool exists)
  price_lamports      REAL,                                -- lamports per whole token
  mcap_lamports       INTEGER,
  progress_pct        REAL,
  vol24h_lamports     INTEGER NOT NULL DEFAULT 0,
  change24h_pct       REAL,
  last_trade_at       INTEGER,
  holders             INTEGER, holders_at INTEGER,
  -- vault mirror
  fees_earned_lamports      INTEGER NOT NULL DEFAULT 0,
  fees_waiting_lamports     INTEGER NOT NULL DEFAULT 0,
  fees_withdrawable_lamports INTEGER NOT NULL DEFAULT 0,
  fees_collectable_lamports INTEGER NOT NULL DEFAULT 0,
  fees_withdrawn_lamports   INTEGER NOT NULL DEFAULT 0,
  owner TEXT, pending_owner TEXT, unlock_ts INTEGER, in_probation INTEGER NOT NULL DEFAULT 0, owner_since INTEGER,
  claim_nonce INTEGER NOT NULL DEFAULT 0,
  fee_crank_at        INTEGER,                             -- last fee-crank attempt (ms)
  market_slot INTEGER, market_at INTEGER, vault_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE INDEX coins_geo        ON coins(lat, lng) WHERE status = 'live';
CREATE INDEX coins_mcap       ON coins(mcap_lamports DESC) WHERE status = 'live';
CREATE INDEX coins_fees       ON coins(fees_earned_lamports DESC) WHERE status = 'live';
CREATE INDEX coins_created    ON coins(created_at DESC);
CREATE INDEX coins_launcher   ON coins(launcher);
CREATE INDEX coins_owner      ON coins(owner);
CREATE INDEX coins_activity   ON coins(last_trade_at DESC);
CREATE INDEX coins_pool       ON coins(pool) WHERE pool IS NOT NULL;

CREATE TABLE trades (
  sig TEXT NOT NULL, ix INTEGER NOT NULL,                  -- ix = event index inside the tx (a tx can hold several)
  mint TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  sol_lamports INTEGER NOT NULL, tokens INTEGER NOT NULL, trader TEXT NOT NULL,
  price_lamports REAL NOT NULL, creator_fee_lamports INTEGER NOT NULL DEFAULT 0,
  venue TEXT NOT NULL CHECK (venue IN ('curve','amm')), slot INTEGER NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (sig, ix)
);
CREATE INDEX trades_mint_ts   ON trades(mint, ts DESC);
CREATE INDEX trades_ts        ON trades(ts DESC);
CREATE INDEX trades_trader_ts ON trades(trader, ts DESC);

CREATE TABLE launch_reservations (
  id TEXT PRIMARY KEY,                                     -- random 128-bit, base64url
  place_id TEXT NOT NULL, place_hash TEXT NOT NULL, launcher TEXT NOT NULL, mint TEXT NOT NULL UNIQUE,
  metadata_id TEXT NOT NULL, category TEXT NOT NULL, emoji TEXT NOT NULL, bg TEXT NOT NULL,
  dev_buy_lamports INTEGER NOT NULL, lat REAL, lng REAL,
  status TEXT NOT NULL CHECK (status IN ('prepared','cosigned','confirmed','expired','failed')),
  cosign_count INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, signature TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip_hash TEXT
);
-- one in-flight (co-signed) launch per place; expire stale rows before inserting/updating
CREATE UNIQUE INDEX reservations_one_locked ON launch_reservations(place_id) WHERE status = 'cosigned';
CREATE INDEX reservations_status ON launch_reservations(status, locked_until);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,                                     -- random 128-bit, base64url
  place_id TEXT NOT NULL, mint TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('call','screen','website','manual')),
  phone_hash TEXT,                                         -- HMAC(HMAC_KEY,'phone:'+E.164); never the number
  verify_ref TEXT,                                         -- Twilio verification sid / website code (not secret)
  code_hash TEXT,                                          -- devnet 'screen' only: HMAC of the code
  status TEXT NOT NULL CHECK (status IN ('calling','verified','cosigned','pending_onchain','finalized','cancelled','expired','failed')),
  calls INTEGER NOT NULL DEFAULT 1, wrong_codes INTEGER NOT NULL DEFAULT 0, cosign_count INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT, token_expires_at INTEGER,
  new_owner TEXT, nonce INTEGER, request_sig TEXT, unlock_ts INTEGER, in_probation INTEGER, finalize_sig TEXT,
  website_host TEXT,                                       -- 'website' method: the listing's own host (looked up server-side)
  onchain_at INTEGER, finalized_at INTEGER,                -- feed timestamps (request confirmed / finalized), ms
  requested_at INTEGER NOT NULL, verified_at INTEGER, last_call_at INTEGER, expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, ip_hash TEXT
);
-- one active PHONE verification per place (website codes are excluded: they live hours, and must not let anyone block
-- phone claims; a second concurrent claim still cannot go pending on-chain while one is, SPEC §5.3 ClaimAlreadyPending)
CREATE UNIQUE INDEX claims_one_active ON claims(place_id) WHERE status IN ('calling','verified','cosigned') AND method != 'website';
CREATE INDEX claims_unlock ON claims(unlock_ts) WHERE status = 'pending_onchain';
CREATE INDEX claims_status ON claims(status, updated_at);

CREATE TABLE phone_verifications (                         -- per-number call log for abuse limits (hashed)
  phone_hash TEXT NOT NULL, ts INTEGER NOT NULL, place_id TEXT NOT NULL, claim_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('started','approved','failed','blocked'))
);
CREATE INDEX phone_ver_hash_ts ON phone_verifications(phone_hash, ts DESC);

CREATE TABLE rate_counters (                               -- durable daily/hourly caps (bindings cover per-minute)
  key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL
);

-- pending_before / pending_top: a backfill that found more than one page of new signatures walks back with
-- `before` across runs; last_sig only advances once the gap down to it is closed.
CREATE TABLE indexer_cursors (
  account TEXT PRIMARY KEY, last_sig TEXT, last_slot INTEGER, updated_at INTEGER NOT NULL,
  pending_before TEXT, pending_top TEXT, pending_top_slot INTEGER
);
CREATE TABLE kv_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  -- keys: sol_usd {usd,at,src} · chain_config {paused,attestor,claimWindowSecs,probationUntil,at} · pump_global {…}
  --       priority_fee · indexer_lock {holder,expires} · indexer_last_run · faucet_balance · rent {r0,r165,r208}

CREATE TABLE chain_events (                                -- shop-vault events seen by the monitor (SPEC §7, §8.6)
  sig TEXT NOT NULL, ix INTEGER NOT NULL, kind TEXT NOT NULL, place_hash TEXT, data_json TEXT NOT NULL,
  slot INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (sig, ix)
);
CREATE TABLE admin_expectations (                          -- ops pre-registers planned AdminChanged proposals
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind INTEGER NOT NULL, key TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, severity TEXT NOT NULL CHECK (severity IN ('info','warn','critical')),
  kind TEXT NOT NULL, message TEXT NOT NULL, ref TEXT, created_at INTEGER NOT NULL, acked_at INTEGER
);
CREATE INDEX alerts_created ON alerts(created_at DESC);
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('report','optout','manual_claim')),
  place_id TEXT, mint TEXT, reason TEXT NOT NULL, details TEXT, contact TEXT, created_at INTEGER NOT NULL, ip_hash TEXT
);
