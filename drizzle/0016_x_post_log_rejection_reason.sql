-- Ensure x_post_log.rejection_reason accepts BELOW_RESOLVED_BETS (and other gate reasons).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rejection_reason') THEN
    CREATE TYPE "rejection_reason" AS ENUM (
      'KALSHI_PUBLIC_POSTING_DISABLED',
      'BELOW_RESOLVED_BETS',
      'BELOW_EV_THRESHOLD',
      'LOW_EV',
      'STAKE_TOO_LOW',
      'BELOW_STAKE_FLOOR',
      'STALE_TRADE',
      'LINE_DRIFT_EXCEEDED',
      'ILLEGIBLE_MARKET',
      'DUPLICATE_TRADE',
      'RECENT_MARKET_POST',
      'Failed Trade EV (< +3.0%)'
    );
  ELSE
    ALTER TYPE "rejection_reason" ADD VALUE IF NOT EXISTS 'BELOW_RESOLVED_BETS';
  END IF;
END $$;
--> statement-breakpoint
-- Drop legacy CHECK constraints that omitted newer rejection reasons.
ALTER TABLE "x_post_log" DROP CONSTRAINT IF EXISTS "x_post_log_rejection_reason_check";
--> statement-breakpoint
-- Promote text column to enum when the table was created from early migrations.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'x_post_log'
      AND column_name = 'rejection_reason'
      AND udt_name = 'text'
  ) THEN
    ALTER TABLE "x_post_log"
      ALTER COLUMN "rejection_reason" TYPE "rejection_reason"
      USING "rejection_reason"::"rejection_reason";
  END IF;
END $$;
