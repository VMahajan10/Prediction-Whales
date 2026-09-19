-- Physical chain identity is global; wallet ledger rows are wallet-perspective-specific.
-- Same canonical_identity may legitimately appear under multiple wallet_address values.
DROP INDEX IF EXISTS "wallet_ledger_events_canonical_identity_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_ledger_events_wallet_canonical_unique"
  ON "wallet_ledger_events" ("wallet_address", "canonical_identity")
  WHERE "canonical_identity" IS NOT NULL;
