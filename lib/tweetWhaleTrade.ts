export interface TweetWhaleTradePayload {
  whaleAddress: string;
  amount: number | string;
  marketName: string;
  side: string;
}

function getTweetApiBaseUrl(): string {
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  if (process.env.NEXT_PUBLIC_VERCEL_URL) {
    return `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`;
  }
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/** Server-only: POST to /api/tweet-whale-trade with the bot secret header. */
export async function triggerTweetWhaleTrade(
  payload: TweetWhaleTradePayload
): Promise<void> {
  const secret = process.env.BOT_API_SECRET;
  if (!secret) {
    console.warn("[tweetWhaleTrade] BOT_API_SECRET is not configured; skipping tweet");
    return;
  }

  const url = `${getTweetApiBaseUrl()}/api/tweet-whale-trade`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bot-secret": secret,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        "[tweetWhaleTrade] tweet request failed:",
        res.status,
        body.slice(0, 200)
      );
    }
  } catch (error) {
    console.error(
      "[tweetWhaleTrade] tweet request error:",
      error instanceof Error ? error.message : error
    );
  }
}
