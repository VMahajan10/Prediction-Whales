/**
 * Trade post lifecycle on x_post_queue (TradePost semantics).
 * DRAFT → SCHEDULED → PUBLISHED
 */
export const POST_STATUS = {
  DRAFT: "DRAFT",
  SCHEDULED: "SCHEDULED",
  PUBLISHED: "PUBLISHED",
  FAILED: "FAILED",
} as const;

export type PostStatus = (typeof POST_STATUS)[keyof typeof POST_STATUS];

/** Statuses that represent an editable draft in the review UI. */
export const DRAFT_QUEUE_STATUSES = new Set([
  "PENDING_REVIEW",
  "EDITED",
  POST_STATUS.DRAFT,
]);

export function isDraftQueueStatus(status: string): boolean {
  return DRAFT_QUEUE_STATUSES.has(status);
}

export function isScheduledQueueStatus(status: string): boolean {
  return status === POST_STATUS.SCHEDULED || status === "APPROVED";
}

export function isPublishedQueueStatus(status: string): boolean {
  return status === POST_STATUS.PUBLISHED || status === "DISPATCHED";
}
