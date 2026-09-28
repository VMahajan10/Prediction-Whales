CREATE TABLE IF NOT EXISTS "x_agent_template_variants" (
  "family" text NOT NULL,
  "variant_id" text NOT NULL,
  "sentences" jsonb NOT NULL,
  "required_placeholders" jsonb NOT NULL,
  "credibility_mode" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("family", "variant_id")
);

CREATE INDEX IF NOT EXISTS "x_agent_template_variants_family_idx"
  ON "x_agent_template_variants" ("family");
