CREATE TABLE IF NOT EXISTS wallet_api_sync_state (
  wallet_address TEXT PRIMARY KEY,
  max_last_event_at BIGINT NOT NULL DEFAULT 0,
  headline_realized_pnl DOUBLE PRECISION,
  positions_sum_closed_realized DOUBLE PRECISION,
  reconciliation_gap_pct DOUBLE PRECISION,
  reconciliation_passed BOOLEAN NOT NULL DEFAULT FALSE,
  last_full_sync_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_api_positions (
  id BIGSERIAL PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  condition_id TEXT,
  status TEXT NOT NULL,
  realized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
  unrealized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
  redeemable BOOLEAN NOT NULL DEFAULT FALSE,
  event_id TEXT,
  event_slug TEXT,
  category_label TEXT,
  title TEXT,
  last_event_at BIGINT NOT NULL DEFAULT 0,
  first_entry_at BIGINT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wallet_api_positions_wallet_token_unique UNIQUE (wallet_address, token_id)
);

CREATE INDEX IF NOT EXISTS wallet_api_positions_wallet_status_idx
  ON wallet_api_positions (wallet_address, status);

CREATE INDEX IF NOT EXISTS wallet_api_positions_wallet_last_event_idx
  ON wallet_api_positions (wallet_address, last_event_at);
