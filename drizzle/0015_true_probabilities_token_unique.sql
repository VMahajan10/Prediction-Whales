-- One canonical p_true row per PM token; upserts refresh this row instead of failing.
DELETE FROM "true_probabilities" t
WHERE t.id NOT IN (
  SELECT DISTINCT ON ("polymarket_token_id") id
  FROM "true_probabilities"
  ORDER BY "polymarket_token_id", "calculated_at" DESC
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "true_probabilities_polymarket_token_id_unique"
  ON "true_probabilities" USING btree ("polymarket_token_id");
