/**
 * Whale trade auto-tweet endpoint.
 *
 * Set these 4 OAuth credentials in the Vercel project dashboard (.env).
 * Canonical names are X_*; TWITTER_* and X_ACCESS_SECRET aliases are also accepted
 * (see lib/twitter/credentials.ts):
 *   X_API_KEY (or TWITTER_API_KEY / X_CONSUMER_KEY)
 *   X_API_SECRET (or TWITTER_API_SECRET / X_CONSUMER_SECRET)
 *   X_ACCESS_TOKEN (or TWITTER_ACCESS_TOKEN)
 *   X_ACCESS_TOKEN_SECRET (or X_ACCESS_SECRET / TWITTER_ACCESS_SECRET)
 *
 * Also set BOT_API_SECRET and pass it as the x-bot-secret request header.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  sendWhaleTweet,
  type WhaleTweetPayload,
} from "@/lib/sendWhaleTweet";

export const dynamic = "force-dynamic";

function isAuthorized(request: NextRequest): boolean {
  const configuredSecret = process.env.BOT_API_SECRET;
  if (!configuredSecret) return false;

  const providedSecret = request.headers.get("x-bot-secret");
  return providedSecret === configuredSecret;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as Partial<WhaleTweetPayload>;
    const result = await sendWhaleTweet({
      tradeId: body.tradeId,
      whaleAddress: body.whaleAddress ?? "",
      amount: body.amount ?? "",
      marketName: body.marketName ?? "",
      side: body.side ?? "",
    });

    if (result.ok) {
      return NextResponse.json({
        success: true,
        tweetId: result.tweetId,
        text: result.text,
      });
    }

    if (result.skipped) {
      return NextResponse.json({
        skipped: true,
        reason: result.reason,
        retryAfterMs: result.retryAfterMs,
      });
    }

    if (result.missingCredentials?.length) {
      return NextResponse.json(
        {
          error: result.error,
          missing: result.missingCredentials,
        },
        { status: 503 }
      );
    }

    if (result.rateLimited) {
      return NextResponse.json({
        success: false,
        rateLimited: true,
        message: result.error,
      });
    }

    if (
      result.error.includes(
        "Missing required fields: whaleAddress, amount, marketName, side"
      )
    ) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json(
      {
        error: "Failed to post tweet",
        message: result.error,
        code: result.code,
        data: result.data,
      },
      { status: 500 }
    );
  } catch (error) {
    console.error("[api/tweet-whale-trade] Unexpected error:", error);
    return NextResponse.json(
      { error: "Failed to post tweet" },
      { status: 500 }
    );
  }
}
