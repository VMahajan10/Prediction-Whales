-- Allow the same canonical chain dedupe_key for different wallets (shared fills).
ALTER TABLE "wallet_ledger_events" DROP CONSTRAINT IF EXISTS "wallet_ledger_events_dedupe_key_unique";
--> statement-breakpoint
ALTER TABLE "wallet_ledger_events" ADD CONSTRAINT "wallet_ledger_events_wallet_dedupe_unique" UNIQUE("wallet_address","dedupe_key");
