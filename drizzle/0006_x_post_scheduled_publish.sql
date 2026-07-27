-- Scheduled X publishing: SCHEDULED / PUBLISHED statuses + x_tweet_id
ALTER TABLE "x_post_queue" DROP CONSTRAINT IF EXISTS "x_post_queue_status_check";

ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "x_tweet_id" text;

ALTER TABLE "x_post_queue" ADD CONSTRAINT "x_post_queue_status_check" CHECK (
  "status" IN (
    'PENDING_REVIEW',
    'APPROVED',
    'EDITED',
    'KILLED',
    'DISPATCHED',
    'EXPIRED',
    'DRAFT',
    'SCHEDULED',
    'PUBLISHED'
  )
);
