import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  xPostQueue,
  type XPostQueue,
  type XPostQueueStatus,
} from "@/lib/crossmarket/store/schema";
import { isDraftQueueStatus } from "@/lib/x-agent/postStatus";
import { getRandomScheduledTime } from "@/lib/x-agent/reviewSchedule";

const REVIEWABLE_STATUSES = new Set<XPostQueueStatus>([
  "PENDING_REVIEW",
  "EDITED",
  "DRAFT",
]);

export function canMutateReviewItem(item: XPostQueue): boolean {
  return (
    REVIEWABLE_STATUSES.has(item.status as XPostQueueStatus) ||
    isDraftQueueStatus(item.status)
  );
}

/** Newest-first ordering for all multi-row x_post_queue reads. */
export const xPostQueueOrderByCreatedDesc = desc(xPostQueue.createdAt);

export async function listXPostQueue(options?: {
  status?: XPostQueueStatus[];
  limit?: number;
}): Promise<XPostQueue[]> {
  if (!isDatabaseEnabled()) return [];

  const db = getDb();
  const limit = options?.limit;

  if (options?.status?.length) {
    const query = db
      .select()
      .from(xPostQueue)
      .where(inArray(xPostQueue.status, options.status))
      .orderBy(xPostQueueOrderByCreatedDesc);
    return limit != null && limit > 0 ? query.limit(limit) : query;
  }

  const query = db
    .select()
    .from(xPostQueue)
    .orderBy(xPostQueueOrderByCreatedDesc);
  return limit != null && limit > 0 ? query.limit(limit) : query;
}

export async function findQueueByReviewToken(
  token: string
): Promise<XPostQueue | null> {
  const trimmed = token.trim();
  if (!trimmed || !isDatabaseEnabled()) return null;

  const db = getDb();
  const [row] = await db
    .select()
    .from(xPostQueue)
    .where(eq(xPostQueue.reviewToken, trimmed))
    .limit(1);

  return row ?? null;
}

export async function findQueueById(id: string): Promise<XPostQueue | null> {
  const trimmed = id.trim();
  if (!trimmed || !isDatabaseEnabled()) return null;

  try {
    const db = getDb();
    const [row] = await db
      .select()
      .from(xPostQueue)
      .where(eq(xPostQueue.id, trimmed))
      .limit(1);

    return row ?? null;
  } catch (error) {
    console.error("[reviewDb] findQueueById failed:", error);
    throw error;
  }
}

export async function updateQueueById(
  id: string,
  patch: {
    status?: XPostQueueStatus;
    copyText?: string;
    scheduledFor?: Date | null;
    dispatchedAt?: Date | null;
    xTweetId?: string | null;
  }
): Promise<XPostQueue | null> {
  const trimmed = id.trim();
  if (!trimmed || !isDatabaseEnabled()) return null;

  const db = getDb();
  const [row] = await db
    .update(xPostQueue)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(eq(xPostQueue.id, trimmed))
    .returning();

  return row ?? null;
}

export async function updateQueueByReviewToken(
  token: string,
  patch: {
    status?: XPostQueueStatus;
    copyText?: string;
    scheduledFor?: Date | null;
    dispatchedAt?: Date | null;
    xTweetId?: string | null;
  }
): Promise<XPostQueue | null> {
  const trimmed = token.trim();
  if (!trimmed || !isDatabaseEnabled()) return null;

  const db = getDb();
  const [row] = await db
    .update(xPostQueue)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(eq(xPostQueue.reviewToken, trimmed))
    .returning();

  return row ?? null;
}

/** Randomized dispatch window 15–120 minutes from now. */
export function computeApprovalScheduledFor(
  random = Math.random
): Date {
  return getRandomScheduledTime(random);
}

/** Posts ready for the cron publisher (scheduledAt <= now). */
export async function listScheduledPostsReadyToPublish(
  limit = 20
): Promise<XPostQueue[]> {
  if (!isDatabaseEnabled()) return [];

  const db = getDb();
  const now = new Date();

  return db
    .select()
    .from(xPostQueue)
    .where(
      and(
        lte(xPostQueue.scheduledFor, now),
        or(
          eq(xPostQueue.status, "SCHEDULED"),
          eq(xPostQueue.status, "APPROVED")
        )
      )
    )
    .orderBy(xPostQueue.scheduledFor)
    .limit(limit);
}

const PUBLISHED_QUEUE_STATUSES: XPostQueueStatus[] = ["PUBLISHED", "DISPATCHED"];

/** Count posts published to X since `since` (typically UTC day start). */
export async function countPublishedPostsSince(since: Date): Promise<number> {
  if (!isDatabaseEnabled()) return 0;

  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(xPostQueue)
    .where(
      and(
        inArray(xPostQueue.status, PUBLISHED_QUEUE_STATUSES),
        gte(xPostQueue.dispatchedAt, since)
      )
    );

  return row?.count ?? 0;
}

export async function countPublishedPostsTodayUtc(now = new Date()): Promise<number> {
  const utcDayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  return countPublishedPostsSince(utcDayStart);
}
