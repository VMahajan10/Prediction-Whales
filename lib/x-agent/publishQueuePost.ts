import { TwitterApi } from "twitter-api-v2";
import type { XPostQueue } from "@/lib/crossmarket/store/schema";
import { POST_STATUS } from "@/lib/x-agent/postStatus";
import { updateQueueById } from "@/lib/x-agent/reviewDb";

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

/**
 * Post a scheduled queue item to X and mark it PUBLISHED on success.
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
    const { data } = await client.readWrite.v2.tweet(text);
    const dispatchedAt = new Date();

    await updateQueueById(item.id, {
      status: POST_STATUS.PUBLISHED,
      xTweetId: data.id,
      dispatchedAt,
    });

    return { ok: true, tweetId: data.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[publishXPostQueueItem] Twitter API error:", message);
    return { ok: false, error: message };
  }
}
