-- Repair kalshi_shadow_trades when the table predates direction columns.
-- CREATE TABLE IF NOT EXISTS (0009) does not add columns to an existing table.
ALTER TABLE "kalshi_shadow_trades" ADD COLUMN IF NOT EXISTS "taker_side" text;
ALTER TABLE "kalshi_shadow_trades" ADD COLUMN IF NOT EXISTS "taker_outcome_side" text;
ALTER TABLE "kalshi_shadow_trades" ADD COLUMN IF NOT EXISTS "taker_book_side" text;
