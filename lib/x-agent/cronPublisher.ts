import { listScheduledPostsReadyToPublish, countScheduledPostsReadyToPublish } from "@/lib/x-agent/reviewDb";
import { publishScheduledQueueItem } from "@/lib/x-agent/publishQueuePost";
import {
  formatDailyLimitLogMessage,
  getDailyPostLimitStatus,
} from "@/lib/x-agent/dailyPostLimit";
import { isXPublisherSchedulerActive } from "@/lib/x-agent/xPublisherScheduler";

export interface CronPublisherResult {
  scanned: number;
  published: number;
  failed: number;
  skipped: number;
  dailyLimitReached?: boolean;
  publishedToday?: number;
  maxDailyPosts?: number;
  errors: Array<{ id: string; error: string }>;
}

const LOG_PREFIX = "[X Publisher]";

/**
 * Publish trade posts where status is SCHEDULED (or legacy APPROVED)
 * and scheduledAt/scheduledFor <= now.
 */
export async function runCronPublisher(): Promise<CronPublisherResult> {
  const result: CronPublisherResult = {
    scanned: 0,
    published: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  if (!isXPublisherSchedulerActive()) {
    console.log(
      `${LOG_PREFIX} Scheduler inactive — skipping x_post_queue scan (set SHADOW_CRON_X_PUBLISHER_ENABLED=true and X API credentials to enable)`
    );
    return result;
  }

  const dueCount = await countScheduledPostsReadyToPublish();
  if (dueCount === 0) {
    console.log(`${LOG_PREFIX} No scheduled posts ready to publish`);
    return result;
  }

  const now = new Date();
  console.log(
    `${LOG_PREFIX} Scanning for due posts (status=SCHEDULED, scheduledAt <= ${now.toISOString()}) | dueCount=${dueCount}`
  );

  const ready = await listScheduledPostsReadyToPublish();
  result.scanned = ready.length;

  const limitStatus = await getDailyPostLimitStatus();
  result.publishedToday = limitStatus.publishedToday;
  result.maxDailyPosts = limitStatus.maxDailyPosts;

  if (limitStatus.limited) {
    result.dailyLimitReached = true;
    result.skipped = ready.length;
    console.log(
      formatDailyLimitLogMessage(
        limitStatus.publishedToday,
        limitStatus.maxDailyPosts
      )
    );
    console.log(
      `${LOG_PREFIX} Run complete — scanned=${result.scanned} published=${result.published} failed=${result.failed} skipped=${result.skipped} (daily limit)`
    );
    return result;
  }

  if (ready.length === 0) {
    return result;
  }

  console.log(
    `${LOG_PREFIX} Found ${ready.length} scheduled post(s) ready to publish | publishedToday=${limitStatus.publishedToday}/${limitStatus.maxDailyPosts}`
  );

  for (const item of ready) {
    const currentLimit = await getDailyPostLimitStatus();
    result.publishedToday = currentLimit.publishedToday;
    result.maxDailyPosts = currentLimit.maxDailyPosts;

    if (currentLimit.limited) {
      result.dailyLimitReached = true;
      const remaining =
        ready.length - result.published - result.failed - result.skipped;
      result.skipped += remaining;
      console.log(
        formatDailyLimitLogMessage(
          currentLimit.publishedToday,
          currentLimit.maxDailyPosts
        )
      );
      break;
    }

    const scheduledLabel = item.scheduledFor?.toISOString() ?? "unknown";
    console.log(
      `${LOG_PREFIX} Publishing queue id=${item.id} tradeId=${item.tradeId} scheduledAt=${scheduledLabel}`
    );

    try {
      const publish = await publishScheduledQueueItem(item);

      if (publish.ok) {
        result.published += 1;
        console.log(
          `${LOG_PREFIX} ✅ Published id=${item.id} status=PUBLISHED xTweetId=${publish.tweetId ?? "n/a"} xMediaId=${publish.mediaId ?? "n/a"} telegramMessageId=${publish.telegramMessageId ?? "n/a"}`
        );
        continue;
      }

      if (publish.skipped) {
        result.skipped += 1;
        console.warn(
          `${LOG_PREFIX} ⏭ Skipped id=${item.id}: ${publish.error ?? "skipped"}`
        );
        continue;
      }

      result.failed += 1;
      const error = publish.error ?? "Publish failed";
      result.errors.push({ id: item.id, error });
      console.error(`${LOG_PREFIX} ❌ Failed id=${item.id}: ${error}`);
    } catch (error) {
      result.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push({ id: item.id, error: message });
      console.error(`${LOG_PREFIX} ❌ Unexpected error id=${item.id}:`, error);
    }
  }

  console.log(
    `${LOG_PREFIX} Run complete — scanned=${result.scanned} published=${result.published} failed=${result.failed} skipped=${result.skipped}`
  );

  return result;
}
