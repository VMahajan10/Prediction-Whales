import type { PrismaClient } from "@prisma/client";

const ACTIVE_QUEUE_STATUSES = [
  "PENDING_REVIEW",
  "EDITED",
  "APPROVED",
] as const;

/** Most recent template family from any queued or published post. */
export async function fetchLastTemplateFamily(
  prisma: PrismaClient
): Promise<string | undefined> {
  const row = await prisma.xPostQueue.findFirst({
    orderBy: { createdAt: "desc" },
    select: { templateFamily: true },
  });
  return row?.templateFamily ?? undefined;
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
    select: { id: true },
  });
  return existing != null;
}
