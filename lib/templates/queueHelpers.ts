import type { PrismaClient } from "@prisma/client";

const ACTIVE_QUEUE_STATUSES = [
  "PENDING_REVIEW",
  "EDITED",
  "APPROVED",
] as const;

/** Prisma orderBy — newest queue rows first. */
export const xPostQueuePrismaOrder = { createdAt: "desc" as const };

/** List x_post_queue rows newest-first (dashboard / admin reads). */
export async function listXPostQueueRows(
  prisma: PrismaClient,
  options?: {
    status?: string[];
    limit?: number;
  }
) {
  return prisma.xPostQueue.findMany({
    where: options?.status?.length
      ? { status: { in: options.status } }
      : undefined,
    orderBy: xPostQueuePrismaOrder,
    take: options?.limit,
  });
}

/** Most recent EV gloss from any queued post (rotation dedupe source). */
export async function fetchLastEvGlossFromQueue(
  prisma: PrismaClient
): Promise<string | null> {
  const row = await prisma.xPostQueue.findFirst({
    orderBy: xPostQueuePrismaOrder,
    select: { evGloss: true },
    where: { evGloss: { not: null } },
  });
  return row?.evGloss ?? null;
}

/** Most recent template family from any queued or published post. */
export async function fetchLastTemplateFamily(
  prisma: PrismaClient
): Promise<string | undefined> {
  const row = await prisma.xPostQueue.findFirst({
    orderBy: xPostQueuePrismaOrder,
    select: { templateFamily: true },
  });
  return row?.templateFamily ?? undefined;
}

/** True when any x_post_queue row already exists for this trade id. */
export async function hasExistingTradeIdInQueue(
  prisma: PrismaClient,
  tradeId: string
): Promise<boolean> {
  const existing = await prisma.xPostQueue.findFirst({
    where: { tradeId },
    select: { id: true },
  });
  return existing != null;
}

/** True when an active queue row already exists for this whale-market pair. */
export async function hasActiveWhaleMarketQueueItem(
  prisma: PrismaClient,
  walletAddress: string,
  marketSlug: string
): Promise<boolean> {
  const existing = await prisma.xPostQueue.findFirst({
    where: {
      walletAddress,
      marketSlug,
      status: { in: [...ACTIVE_QUEUE_STATUSES] },
    },
    orderBy: xPostQueuePrismaOrder,
    select: { id: true },
  });
  return existing != null;
}
