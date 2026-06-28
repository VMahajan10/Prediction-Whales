-- Allow pipeline test + token-boost match methods on market_mappings.

ALTER TABLE "market_mappings" DROP CONSTRAINT IF EXISTS "market_mappings_match_method_check";
--> statement-breakpoint
ALTER TABLE "market_mappings" ADD CONSTRAINT "market_mappings_match_method_check" CHECK (
	"match_method" IN (
		'deterministic',
		'string',
		'vector',
		'llm',
		'manual',
		'token_boost',
		'token_heuristic',
		'TEST_FALLBACK_PAIR'
	)
);
