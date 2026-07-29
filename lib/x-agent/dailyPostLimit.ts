import { countPublishedPostsTodayUtc } from "@/lib/x-agent/reviewDb";

/** Default max X posts per UTC calendar day. */
export const MAX_DAILY_POSTS_DEFAULT = 5;

/** Hard ceiling for MAX_DAILY_POSTS (env cannot exceed this). */
export const MAX_DAILY_POSTS_HARD_CAP = 6;

/**
 * Resolved daily publish cap (default 5, env override clamped to 6).
 */
export function resolveMaxDailyPosts(): number {
  const parsed = Number(process.env.MAX_DAILY_POSTS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return MAX_DAILY_POSTS_DEFAULT;
  }
  return Math.min(Math.floor(parsed), MAX_DAILY_POSTS_HARD_CAP);
}

/** UTC midnight for the calendar day containing `now`. */
export function getUtcDayStart(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

export function formatDailyLimitLogMessage(
  publishedToday: number,
  maxDailyPosts: number
): string {
  return `[X Publisher] Daily post limit reached (${publishedToday}/${maxDailyPosts}). Skipping further publishes until tomorrow.`;
}

export interface DailyPostLimitStatus {
  limited: boolean;
  publishedToday: number;
  maxDailyPosts: number;
}

export async function getDailyPostLimitStatus(
  countPublishedToday: () => Promise<number> = countPublishedPostsTodayUtc
): Promise<DailyPostLimitStatus> {
  const maxDailyPosts = resolveMaxDailyPosts();
  const publishedToday = await countPublishedToday();
  return {
    limited: publishedToday >= maxDailyPosts,
    publishedToday,
    maxDailyPosts,
  };
}
