import { TwitterApi } from "twitter-api-v2";
import type { XPostQueue } from "@/lib/crossmarket/store/schema";
import {
  isTwitterCredentialsConfigured,
  resolveTwitterCredentials,
} from "@/lib/twitter/credentials";
import { POST_STATUS } from "@/lib/x-agent/postStatus";
import {
  parseTwitterPublishError,
  recordPublishFailure,
} from "@/lib/x-agent/publishRetry";
import { updateQueueById } from "@/lib/x-agent/reviewDb";
import { sendPublicTelegramPost } from "@/lib/services/publicTelegramService";

const LOG_PREFIX = "[publishScheduledQueueItem]";

export interface PublishQueuePostResult {
  ok: boolean;
  skipped?: boolean;
  tweetId?: string;
  telegramMessageId?: string;
  telegramError?: string;
  error?: string;
  rateLimited?: boolean;
  statusCode?: number;
  retryCount?: number;
  rescheduledFor?: string;
  failedPermanently?: boolean;
}

/** True when all X API credentials are configured for scheduled publishing. */
export function isTwitterPublishingConfigured(): boolean {
  return isTwitterCredentialsConfigured();
}

/** Post template copy to X — text only, no media attachments. */
async function publishToX(
  text: string
): Promise<PublishQueuePostResult> {
  const credentialCheck = resolveTwitterCredentials();
  if (!credentialCheck.ok) {
    return {
      ok: false,
      skipped: true,
      error: `Twitter credentials missing: ${credentialCheck.missing.join(", ")}`,
    };
  }

  const client = new TwitterApi({
    appKey: credentialCheck.appKey,
    appSecret: credentialCheck.appSecret,
    accessToken: credentialCheck.accessToken,
    accessSecret: credentialCheck.accessSecret,
  });

  try {
    const { data } = await client.readWrite.v2.tweet(text);
    return { ok: true, tweetId: data.id };
  } catch (error) {
    const classified = parseTwitterPublishError(error);
    console.error(
      `${LOG_PREFIX} Twitter API error (status=${classified.statusCode ?? "n/a"}):`,
      classified.message
    );
    return {
      ok: false,
      error: classified.message,
      rateLimited: classified.rateLimited,
      statusCode: classified.statusCode,
    };
  }
}

async function handlePublishFailure(
  item: XPostQueue,
  error: { message: string; rateLimited?: boolean; statusCode?: number }
): Promise<PublishQueuePostResult> {
  const classified = parseTwitterPublishError(error);
  const outcome = await recordPublishFailure(item, classified);

  if (outcome.action === "rescheduled") {
    console.warn(
      `${LOG_PREFIX} ⏳ Rescheduled id=${item.id} retry=${outcome.retryCount} scheduledFor=${outcome.scheduledFor.toISOString()}${classified.rateLimited ? " (rate limited)" : ""}`
    );
    return {
      ok: false,
      error: classified.message,
      rateLimited: classified.rateLimited,
      statusCode: classified.statusCode,
      retryCount: outcome.retryCount,
      rescheduledFor: outcome.scheduledFor.toISOString(),
    };
  }

  console.error(
    `${LOG_PREFIX} 🛑 Marked FAILED id=${item.id} after ${outcome.retryCount} publish attempts`
  );
  return {
    ok: false,
    error: classified.message,
    rateLimited: classified.rateLimited,
    statusCode: classified.statusCode,
    retryCount: outcome.retryCount,
    failedPermanently: true,
  };
}

/**
 * Dual-publish a scheduled queue item to X and the public Telegram channel.
 * Both channels receive plain template text only — no image or media attachments.
 * X success is required to mark PUBLISHED; Telegram failure is logged but non-blocking.
 */
export async function publishScheduledQueueItem(
  item: XPostQueue
): Promise<PublishQueuePostResult> {
  const text = item.copyText.trim();
  if (!text) {
    const outcome = await recordPublishFailure(item, {
      message: "Post copy is empty",
      rateLimited: false,
      retryable: false,
    });
    return {
      ok: false,
      error: "Post copy is empty",
      failedPermanently: outcome.action === "failed",
      retryCount: outcome.retryCount,
    };
  }

  const [xOutcome, telegramOutcome] = await Promise.allSettled([
    publishToX(text),
    sendPublicTelegramPost(text),
  ]);

  const xResult: PublishQueuePostResult =
    xOutcome.status === "fulfilled"
      ? xOutcome.value
      : {
          ok: false,
          error: String(xOutcome.reason),
        };

  const telegramResult =
    telegramOutcome.status === "fulfilled"
      ? telegramOutcome.value
      : { sent: false as const, error: String(telegramOutcome.reason) };

  if (xResult.ok) {
    console.log(
      `${LOG_PREFIX} ✅ X published id=${item.id} xTweetId=${xResult.tweetId ?? "n/a"}`
    );
  } else if (!xResult.skipped) {
    console.error(
      `${LOG_PREFIX} ❌ X failed id=${item.id}: ${xResult.error ?? "unknown"}`
    );
  }

  if (telegramResult.sent) {
    console.log(
      `${LOG_PREFIX} ✅ Telegram published id=${item.id} messageId=${telegramResult.messageId ?? "n/a"}`
    );
  } else if (telegramResult.skipped) {
    console.warn(
      `${LOG_PREFIX} ⏭ Telegram skipped id=${item.id}: ${telegramResult.error ?? "not configured"}`
    );
  } else {
    console.error(
      `${LOG_PREFIX} ❌ Telegram failed id=${item.id}: ${telegramResult.error ?? "unknown"}`
    );
  }

  if (!xResult.ok) {
    if (xResult.skipped) {
      return {
        ok: false,
        skipped: true,
        error: xResult.error,
        telegramMessageId: telegramResult.messageId,
        telegramError: telegramResult.error,
      };
    }

    const failure = await handlePublishFailure(item, {
      message: xResult.error ?? "Publish failed",
      rateLimited: xResult.rateLimited,
      statusCode: xResult.statusCode,
    });

    return {
      ...failure,
      telegramMessageId: telegramResult.messageId,
      telegramError: telegramResult.error,
    };
  }

  await updateQueueById(item.id, {
    status: POST_STATUS.PUBLISHED,
    xTweetId: xResult.tweetId,
    xMediaId: null,
    publicTelegramMessageId: telegramResult.messageId ?? null,
    dispatchedAt: new Date(),
    publishRetryCount: 0,
    lastPublishError: null,
  });

  return {
    ok: true,
    tweetId: xResult.tweetId,
    telegramMessageId: telegramResult.messageId,
    telegramError: telegramResult.sent ? undefined : telegramResult.error,
  };
}

/** @alias publishScheduledQueueItem */
export async function publishXPostQueueItem(
  item: XPostQueue
): Promise<PublishQueuePostResult> {
  return publishScheduledQueueItem(item);
}
