-- Nullable X media attachment fields for published whale trade receipts.
ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "x_media_id" text;
ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "receipt_media_url" text;
