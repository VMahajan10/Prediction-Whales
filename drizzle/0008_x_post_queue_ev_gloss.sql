-- EV gloss rotation: last-used plain-English AVG EV phrase per queued post
ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "ev_gloss" text;
