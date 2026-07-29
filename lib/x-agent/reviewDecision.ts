import { formatToEST } from "@/lib/client-utils";
import {
  isDraftQueueStatus,
  isPublishedQueueStatus,
  isScheduledQueueStatus,
} from "@/lib/x-agent/postStatus";
import type { XPostQueueStatus } from "@/lib/crossmarket/store/schema";

/** Queue rows still awaiting cofounder accept / reject / edit decision. */
export const PENDING_REVIEW_STATUSES: XPostQueueStatus[] = [
  "PENDING_REVIEW",
  "EDITED",
  "DRAFT",
];

export function isPendingReviewStatus(status: string): boolean {
  return isDraftQueueStatus(status);
}

export function buildDecisionConflictMessage(decidedBy: string | null): string {
  const who = decidedBy?.trim() || "another cofounder";
  return `This trade decision has already been finalized by ${who}.`;
}

export function normalizeDecidedBy(value: string | undefined | null): string {
  const trimmed = value?.trim();
  return trimmed || "Review page";
}

export function formatReviewDecisionBadge(
  status: string,
  decidedBy?: string | null,
  decidedAt?: Date | string | number | null
): string | null {
  if (isPendingReviewStatus(status)) return null;

  const who = decidedBy?.trim() || "a cofounder";
  const when =
    decidedAt != null && !Number.isNaN(new Date(decidedAt).getTime())
      ? formatToEST(decidedAt)
      : null;

  if (status === "KILLED") {
    return when ? `Rejected by ${who} · ${when}` : `Rejected by ${who}`;
  }

  if (isScheduledQueueStatus(status)) {
    return when ? `Scheduled by ${who} · ${when}` : `Approved by ${who}`;
  }

  if (isPublishedQueueStatus(status)) {
    return when ? `Published · decided by ${who} · ${when}` : `Published`;
  }

  if (status === "EXPIRED") {
    return when ? `Expired · ${when}` : "Expired";
  }

  return `Finalized (${status.replace(/_/g, " ")}) by ${who}`;
}
