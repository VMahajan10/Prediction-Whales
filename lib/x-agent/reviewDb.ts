import { desc, eq, inArray } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  xPostQueue,
  type XPostQueue,
  type XPostQueueStatus,
} from "@/lib/crossmarket/store/schema";

const REVIEWABLE_STATUSES = new Set<XPostQueueStatus>([
  "PENDING_REVIEW",
  "EDITED",
]);

export function canMutateReviewItem(item: XPostQueue): boolean {
  return REVIEWABLE_STATUSES.has(item.status as XPostQueueStatus);
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

  const db = getDb();
  const [row] = await db
    .select()
    .from(xPostQueue)
    .where(eq(xPostQueue.id, trimmed))
    .limit(1);

  return row ?? null;
}

export async function updateQueueById(
  id: string,
  patch: {
    status?: XPostQueueStatus;
    copyText?: string;
    scheduledFor?: Date | null;
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

/** Randomized dispatch window 120–180 minutes from now. */
export function computeApprovalScheduledFor(
  random = Math.random
): Date {
  const minMs = 120 * 60 * 1000;
  const maxMs = 180 * 60 * 1000;
  const jitterMs = minMs + random() * (maxMs - minMs);
  return new Date(Date.now() + jitterMs);
}
