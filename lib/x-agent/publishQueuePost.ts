import { TwitterApi } from "twitter-api-v2";
import type { XPostQueue } from "@/lib/crossmarket/store/schema";
import {
  generateWhaleReceiptPng,
  resolveWhaleReceiptData,
} from "@/lib/x-agent/generateWhaleReceiptPng";
import { POST_STATUS } from "@/lib/x-agent/postStatus";
import { updateQueueById } from "@/lib/x-agent/reviewDb";

const LOG_PREFIX = "[publishXPostQueueItem]";
const TWITTER_CREDENTIAL_KEYS = [
  "X_API_KEY",
  "X_API_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_TOKEN_SECRET",
] as const;

type TwitterCredentialKey = (typeof TWITTER_CREDENTIAL_KEYS)[number];

export interface PublishQueuePostResult {
  ok: boolean;
  skipped?: boolean;
  tweetId?: string;
  mediaId?: string;
  error?: string;
}

function validateTwitterCredentials():
  | {
      ok: true;
      appKey: string;
      appSecret: string;
      accessToken: string;
      accessSecret: string;
    }
  | { ok: false; missing: TwitterCredentialKey[] } {
  const values: Record<TwitterCredentialKey, string | undefined> = {
    X_API_KEY: process.env.X_API_KEY,
    X_API_SECRET: process.env.X_API_SECRET,
    X_ACCESS_TOKEN: process.env.X_ACCESS_TOKEN,
    X_ACCESS_TOKEN_SECRET: process.env.X_ACCESS_TOKEN_SECRET,
  };

  const missing = TWITTER_CREDENTIAL_KEYS.filter((key) => !values[key]?.trim());
  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    appKey: values.X_API_KEY!.trim(),
    appSecret: values.X_API_SECRET!.trim(),
    accessToken: values.X_ACCESS_TOKEN!.trim(),
    accessSecret: values.X_ACCESS_TOKEN_SECRET!.trim(),
  };
}

async function uploadReceiptMedia(
  client: TwitterApi,
  item: XPostQueue
): Promise<string | null> {
  if (item.xMediaId?.trim()) {
    return item.xMediaId.trim();
  }

  try {
    const receiptData = await resolveWhaleReceiptData(item);
    const pngBuffer = await generateWhaleReceiptPng(receiptData);
    const mediaId = await client.v1.uploadMedia(pngBuffer, { type: "png" });
    return mediaId;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Receipt image generation/upload failed for queue id=${item.id} — posting text only`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * Post a scheduled queue item to X and mark it PUBLISHED on success.
 * Generates a whale receipt PNG and attaches it when media upload succeeds.
 * Failures leave the row in SCHEDULED so the cron worker can retry.
 */
export async function publishXPostQueueItem(
  item: XPostQueue
): Promise<PublishQueuePostResult> {
  const text = item.copyText.trim();
  if (!text) {
    return { ok: false, error: "Post copy is empty" };
  }

  const credentialCheck = validateTwitterCredentials();
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
    const mediaId = await uploadReceiptMedia(client, item);

    const response =
      mediaId != null
        ? await client.readWrite.v2.tweet(text, {
            media: { media_ids: [mediaId] },
          })
        : await client.readWrite.v2.tweet(text);
    const { data } = response;
    const dispatchedAt = new Date();

    await updateQueueById(item.id, {
      status: POST_STATUS.PUBLISHED,
      xTweetId: data.id,
      xMediaId: mediaId,
      dispatchedAt,
    });

    return { ok: true, tweetId: data.id, mediaId: mediaId ?? undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} Twitter API error:`, message);
    return { ok: false, error: message };
  }
}
