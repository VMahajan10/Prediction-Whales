ALTER TABLE wallet_api_positions
  ADD COLUMN IF NOT EXISTS current_price double precision;

ALTER TABLE wallet_api_sync_state
  ADD COLUMN IF NOT EXISTS positions_sum_reconciliation double precision,
  ADD COLUMN IF NOT EXISTS full_sync_status text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS closed_positions_cached integer NOT NULL DEFAULT 0;
