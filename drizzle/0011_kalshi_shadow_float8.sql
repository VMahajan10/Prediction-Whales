ALTER TABLE "kalshi_shadow_trades"
  ALTER COLUMN "size" TYPE double precision USING "size"::double precision,
  ALTER COLUMN "entry_price" TYPE double precision USING "entry_price"::double precision,
  ALTER COLUMN "usd_notional" TYPE double precision USING "usd_notional"::double precision;
