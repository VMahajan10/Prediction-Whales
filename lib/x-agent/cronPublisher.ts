import { listScheduledPostsReadyToPublish } from "@/lib/x-agent/reviewDb";
import { publishXPostQueueItem } from "@/lib/x-agent/publishQueuePost";

export interface CronPublisherResult {
  scanned: number;
  published: number;
  failed: number;
  skipped: number;
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

  const now = new Date();
  console.log(
    `${LOG_PREFIX} Scanning for due posts (status=SCHEDULED, scheduledAt <= ${now.toISOString()})`
  );

  const ready = await listScheduledPostsReadyToPublish();
  result.scanned = ready.length;

  if (ready.length === 0) {
    console.log(`${LOG_PREFIX} No scheduled posts ready to publish`);
    return result;
  }

  console.log(
    `${LOG_PREFIX} Found ${ready.length} scheduled post(s) ready to publish`
  );

  for (const item of ready) {
    const scheduledLabel = item.scheduledFor?.toISOString() ?? "unknown";
    console.log(
      `${LOG_PREFIX} Publishing queue id=${item.id} tradeId=${item.tradeId} scheduledAt=${scheduledLabel}`
    );

    try {
      const publish = await publishXPostQueueItem(item);

      if (publish.ok) {
        result.published += 1;
        console.log(
          `${LOG_PREFIX} ✅ Published id=${item.id} status=PUBLISHED xTweetId=${publish.tweetId ?? "n/a"}`
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
