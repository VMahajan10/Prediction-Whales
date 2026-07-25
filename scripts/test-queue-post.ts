/**
 * Insert a dummy x_post_queue row for local / Prisma Studio verification.
 *
 * Usage:
 *   npx tsx scripts/test-queue-post.ts
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { disconnectPrisma, getPrisma, isPrismaEnabled } from "../lib/prisma";

dotenv.config({ path: ".env.local", override: false });
dotenv.config({ override: false });

async function main(): Promise<void> {
  if (!isPrismaEnabled()) {
    console.error("[test-queue-post] DATABASE_URL is not set");
    process.exit(1);
  }

  const prisma = getPrisma();
  if (!prisma) {
    console.error("[test-queue-post] Prisma client is not available");
    process.exit(1);
  }

  const id = randomUUID();
  const tradeId = `test-queue-${Date.now()}`;
  const reviewToken = randomUUID();

  try {
    const row = await prisma.xPostQueue.create({
      data: {
        id,
        walletAddress: "0x1111111111111111111111111111111111111111",
        tradeId,
        templateFamily: "test",
        copyText:
          "[TEST] Dummy x_post_queue row — safe to delete after Prisma Studio check.",
        marketSlug: "test-market-slug",
        side: "YES",
        entryCents: 45,
        nowCents: 52,
        stakeNotional: 25_000,
        status: "PENDING_REVIEW",
        reviewToken,
      },
    });

    const total = await prisma.xPostQueue.count();
    console.log(
      `[test-queue-post] Created row id=${row.id} tradeId=${row.tradeId} status=${row.status}`
    );
    console.log(`[test-queue-post] x_post_queue row count: ${total}`);
  } catch (error) {
    console.error("[test-queue-post] Insert failed:", error);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }

  process.exit(process.exitCode ?? 0);
}

void main();
