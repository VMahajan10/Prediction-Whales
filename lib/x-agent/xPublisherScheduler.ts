import "server-only";

import { isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { isTwitterPublishingConfigured } from "@/lib/x-agent/publishQueuePost";

/** Default X publisher tick interval (10–15s range). Override via env. */
export const DEFAULT_X_PUBLISHER_INTERVAL_MS = 15_000;

export function resolveXPublisherIntervalMs(): number {
  const parsed = Number(process.env.SHADOW_CRON_X_PUBLISHER_INTERVAL_MS);
  if (Number.isFinite(parsed) && parsed >= 10_000) {
    return Math.min(parsed, 120_000);
  }
  return DEFAULT_X_PUBLISHER_INTERVAL_MS;
}

/**
 * Scheduler is active when publishing is enabled, DB is available, and X credentials exist.
 * When false, the shadow cron skips x_post_queue reads entirely.
 */
export function isXPublisherSchedulerActive(): boolean {
  const explicit = process.env.SHADOW_CRON_X_PUBLISHER_ENABLED?.trim().toLowerCase();
  if (explicit === "false" || explicit === "0") return false;
  if (!isDatabaseEnabled()) return false;
  return isTwitterPublishingConfigured();
}
