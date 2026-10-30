CREATE INDEX IF NOT EXISTS "wallet_ledger_events_wallet_dedupe_null_ts_idx"
  ON "wallet_ledger_events" ("wallet_address", "dedupe_key")
  WHERE "block_timestamp" IS NULL;
