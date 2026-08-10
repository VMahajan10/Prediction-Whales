/**
 * Emergency cleanup: mark stuck SCHEDULED rows as FAILED so the publisher stops
 * retrying them every 15s while Twitter rate limits cool down.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.json scripts/fail-stuck-queue-items.ts
 *
 * SQL equivalent:
 *   UPDATE x_post_queue
 *   SET status = 'FAILED',
 *       last_publish_error = 'Manually failed — stuck publish retry loop',
 *       updated_at = NOW()
 *   WHERE id IN (
 *     '51591f3f-d87e-4fb9-a943-48b60c1ea5fb',
 *     '0f65c40a-534a-409c-883f-04517ac8f9ff'
 *   );
 */
import "./preload-env";
import { disconnectPrisma, getPrisma, isPrismaEnabled } from "../lib/prisma";
import { ensureXPostQueueSchemaOnce } from "../lib/x-agent/ensureXPostQueueSchema";

const STUCK_QUEUE_IDS = [
  "51591f3f-d87e-4fb9-a943-48b60c1ea5fb",
  "0f65c40a-534a-409c-883f-04517ac8f9ff",
] as const;

const FAILURE_REASON = "Manually failed — stuck publish retry loop";

async function main(): Promise<void> {
  if (!isPrismaEnabled()) {
    console.error("[fail-stuck-queue-items] DATABASE_URL is not set");
    process.exit(1);
  }

  const prisma = getPrisma();
  if (!prisma) {
    console.error("[fail-stuck-queue-items] Prisma client is not available");
    process.exit(1);
  }

  await ensureXPostQueueSchemaOnce(prisma);

  for (const id of STUCK_QUEUE_IDS) {
    const existing = await prisma.xPostQueue.findUnique({ where: { id } });
    if (!existing) {
      console.warn(`[fail-stuck-queue-items] Row not found: ${id}`);
      continue;
    }

    const updated = await prisma.xPostQueue.update({
      where: { id },
      data: {
        status: "FAILED",
        lastPublishError: FAILURE_REASON,
      },
    });

    console.log(
      `[fail-stuck-queue-items] Marked FAILED id=${updated.id} tradeId=${updated.tradeId} (was ${existing.status})`
    );
  }
}

main()
  .catch((error) => {
    console.error("[fail-stuck-queue-items] Fatal error:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
