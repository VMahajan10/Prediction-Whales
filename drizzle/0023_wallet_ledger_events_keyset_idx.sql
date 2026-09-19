CREATE INDEX IF NOT EXISTS "wallet_ledger_events_wallet_block_id_idx"
  ON "wallet_ledger_events" ("wallet_address", "block_number", "id");
