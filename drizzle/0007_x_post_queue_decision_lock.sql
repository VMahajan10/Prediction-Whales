ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "decided_by" text;
ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "decided_at" timestamptz;
