-- Business opt-outs (worker/takedown.ts): places whose business asked not to be listed, so no coin can be launched for
-- them (launch prepare → 422 place_opted_out). Written only by ops with `scripts/moderate.mjs --optout <placeId>` after
-- checking the requester (RUNBOOK takedown process), and works whether or not the place has a coin yet. No personal
-- data here: the request itself (name, email) stays in `reports`, where it is scrubbed after 180 days.
CREATE TABLE IF NOT EXISTS place_optouts (
  place_id   TEXT PRIMARY KEY,                             -- canonical Google place.id (or devnet 'cornershop-test:*')
  created_at INTEGER NOT NULL                              -- ms
);

-- Owner alerts (worker/ownerAlerts.ts) are de-duplicated by (kind, ref) over up to 30 days, and now every report adds
-- one: look them up by index instead of scanning a month of alerts.
CREATE INDEX IF NOT EXISTS alerts_kind_ref ON alerts(kind, ref, created_at);
