ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "sentence_order_index" integer;
ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "receipt_for_queue_id" text;
CREATE UNIQUE INDEX IF NOT EXISTS "x_post_queue_receipt_for_queue_id_unique" ON "x_post_queue" ("receipt_for_queue_id");
