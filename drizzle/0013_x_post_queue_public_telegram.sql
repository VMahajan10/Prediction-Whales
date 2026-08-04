ALTER TABLE "x_post_queue"
  ADD COLUMN IF NOT EXISTS "public_telegram_message_id" text;
