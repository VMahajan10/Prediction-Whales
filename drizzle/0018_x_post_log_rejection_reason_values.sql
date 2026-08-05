-- Backfill rejection_reason enum values required by x_post_log gate logging.

DO $$
DECLARE
  reason text;
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
    FOR reason IN
      SELECT unnest(
        ARRAY[
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
        ]
      )
    LOOP
      EXECUTE format('ALTER TYPE "rejection_reason" ADD VALUE IF NOT EXISTS %L', reason);
    END LOOP;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "x_post_log" DROP CONSTRAINT IF EXISTS "x_post_log_rejection_reason_check";
