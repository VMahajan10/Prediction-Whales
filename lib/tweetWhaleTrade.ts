import {
  sendWhaleTweet,
  type WhaleTweetPayload,
} from "@/lib/sendWhaleTweet";

export type TweetWhaleTradePayload = WhaleTweetPayload;

/** Server-only: post whale alert directly (no self-HTTP). */
export async function triggerTweetWhaleTrade(
  payload: TweetWhaleTradePayload
): Promise<void> {
  try {
    const result = await sendWhaleTweet(payload);
    if (!result.ok && !result.skipped) {
      console.error("[tweetWhaleTrade] sendWhaleTweet failed:", result.error);
    }
  } catch (error) {
    console.error(
      "[tweetWhaleTrade] sendWhaleTweet error:",
      error instanceof Error ? error.message : error
    );
  }
}
