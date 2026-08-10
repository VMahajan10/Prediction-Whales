import "server-only";

import { sql } from "drizzle-orm";
import type { PrismaClient } from "@prisma/client";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";

/**
 * Idempotent DDL patches for x_post_queue — mirrors drizzle migrations when
 * production lags behind prisma/schema.prisma (P2022 missing column).
 */
const X_POST_QUEUE_SCHEMA_PATCHES = [
  `ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "variant_id" text`,
  `ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "ev_gloss" text`,
  `ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "x_media_id" text`,
  `ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "receipt_media_url" text`,
  `ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "public_telegram_message_id" text`,
  `ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "publish_retry_count" integer NOT NULL DEFAULT 0`,
  `ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "last_publish_error" text`,
] as const;

let drizzleSchemaEnsurePromise: Promise<void> | null = null;

export async function ensureXPostQueueDrizzleSchemaOnce(): Promise<void> {
  if (!isDatabaseEnabled()) return;

  if (!drizzleSchemaEnsurePromise) {
    drizzleSchemaEnsurePromise = (async () => {
      const db = getDb();
      for (const patch of X_POST_QUEUE_SCHEMA_PATCHES) {
        await db.execute(sql.raw(patch));
      }
    })().catch((error) => {
      drizzleSchemaEnsurePromise = null;
      throw error;
    });
  }

  await drizzleSchemaEnsurePromise;
}

let schemaEnsurePromise: Promise<void> | null = null;

export function isPrismaMissingColumnError(
  error: unknown,
  column?: string
): boolean {
  if (!error || typeof error !== "object") return false;

  const record = error as { code?: string; message?: string };
  if (record.code !== "P2022") return false;

  const message = record.message ?? "";
  if (!column) return true;
  return message.includes(column);
}

export async function ensureXPostQueueSchema(
  prisma: PrismaClient
): Promise<void> {
  for (const patch of X_POST_QUEUE_SCHEMA_PATCHES) {
    await prisma.$executeRawUnsafe(patch);
  }
}

/** Run schema patches once per process (safe on worker boot and before enqueue). */
export async function ensureXPostQueueSchemaOnce(
  prisma: PrismaClient
): Promise<void> {
  if (!schemaEnsurePromise) {
    schemaEnsurePromise = ensureXPostQueueSchema(prisma).catch((error) => {
      schemaEnsurePromise = null;
      throw error;
    });
  }

  await schemaEnsurePromise;
}
