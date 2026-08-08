ALTER TABLE "feed_trades" ADD COLUMN IF NOT EXISTS "category" text;

ALTER TABLE "kalshi_shadow_trades" ADD COLUMN IF NOT EXISTS "category" text;

CREATE INDEX IF NOT EXISTS "feed_trades_category_traded_at_idx"
  ON "feed_trades" ("category", "traded_at" DESC);

CREATE INDEX IF NOT EXISTS "kalshi_shadow_trades_category_traded_at_idx"
  ON "kalshi_shadow_trades" ("category", "traded_at" DESC);
