/** x_post_queue.status values — shared by Drizzle schema and client review UI. */
export const X_POST_QUEUE_STATUSES = [
  "PENDING_REVIEW",
  "DRAFT",
  "APPROVED",
  "EDITED",
  "KILLED",
  "SCHEDULED",
  "PUBLISHED",
  "DISPATCHED",
  "FAILED",
  "EXPIRED",
] as const;

export type XPostQueueStatus = (typeof X_POST_QUEUE_STATUSES)[number];
