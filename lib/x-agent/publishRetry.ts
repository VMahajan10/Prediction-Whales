import "server-only";

import type { XPostQueue } from "@/lib/crossmarket/store/schema";
import { updateQueueById } from "@/lib/x-agent/reviewDb";

/** Max publish attempts before marking the queue row FAILED. */
export const MAX_PUBLISH_RETRIES = 3;

/** Backoff when X returns HTTP 429 (15 minutes). */
export const RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;

/** Exponential backoff for other retryable API errors. */
export const RETRY_BACKOFF_MS = [30_000, 120_000, RATE_LIMIT_BACKOFF_MS] as const;

export interface TwitterPublishErrorInfo {
  message: string;
  statusCode?: number;
  rateLimited: boolean;
  retryable: boolean;
}

export type PublishFailureOutcome =
  | { action: "rescheduled"; retryCount: number; scheduledFor: Date }
  | { action: "failed"; retryCount: number };

export function parseTwitterPublishError(error: unknown): TwitterPublishErrorInfo {
  const apiError = error as {
    code?: number;
    status?: number;
    message?: string;
    data?: { detail?: string; title?: string };
  };

  const statusCode = apiError?.code ?? apiError?.status;
  const rateLimited = statusCode === 429;
  const detail =
    typeof apiError?.data?.detail === "string" ? apiError.data.detail : null;
  const message = (detail ?? apiError?.message ?? String(error)).trim();

  const haystack = message.toLowerCase();
  const retryable =
    rateLimited ||
    (statusCode != null && statusCode >= 500) ||
    haystack.includes("rate limit") ||
    haystack.includes("too many requests");

  return {
    message: message || "Twitter publish failed",
    statusCode,
    rateLimited,
    retryable,
  };
}

export function resolvePublishRetryBackoffMs(
  retryCount: number,
  rateLimited: boolean
): number {
  if (rateLimited) return RATE_LIMIT_BACKOFF_MS;
  const index = Math.min(Math.max(retryCount - 1, 0), RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[index] ?? RATE_LIMIT_BACKOFF_MS;
}

export function resolvePublishFailureAction(
  currentRetryCount: number,
  error: Pick<TwitterPublishErrorInfo, "rateLimited" | "retryable">
): "reschedule" | "fail" {
  const nextRetry = currentRetryCount + 1;

  if (error.rateLimited) {
    return "reschedule";
  }

  if (!error.retryable) {
    return "fail";
  }

  return nextRetry >= MAX_PUBLISH_RETRIES ? "fail" : "reschedule";
}

/**
 * Increment retry metadata and either reschedule or mark FAILED so due SCHEDULED
 * rows stop re-firing every publisher tick.
 */
export async function recordPublishFailure(
  item: XPostQueue,
  error: TwitterPublishErrorInfo
): Promise<PublishFailureOutcome> {
  const currentRetry = item.publishRetryCount ?? 0;
  const nextRetry = currentRetry + 1;
  const action = resolvePublishFailureAction(currentRetry, error);
  const errorText = error.message.slice(0, 500);

  if (action === "reschedule") {
    const backoffMs = resolvePublishRetryBackoffMs(nextRetry, error.rateLimited);
    const scheduledFor = new Date(Date.now() + backoffMs);

    await updateQueueById(item.id, {
      publishRetryCount: nextRetry,
      lastPublishError: errorText,
      scheduledFor,
    });

    return { action: "rescheduled", retryCount: nextRetry, scheduledFor };
  }

  await updateQueueById(item.id, {
    status: "FAILED",
    publishRetryCount: nextRetry,
    lastPublishError: errorText,
  });

  return { action: "failed", retryCount: nextRetry };
}
