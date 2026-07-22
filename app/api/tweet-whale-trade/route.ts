/**
 * Whale trade auto-tweet endpoint.
 *
 * Set these 4 environment variables in the Vercel project dashboard (.env):
 *   X_API_KEY
 *   X_API_SECRET
 *   X_ACCESS_TOKEN
 *   X_ACCESS_TOKEN_SECRET
 *
 * Also set BOT_API_SECRET and pass it as the x-bot-secret request header.
 */

import { NextRequest, NextResponse } from "next/server";
import { TwitterApi } from "twitter-api-v2";

export const dynamic = "force-dynamic";

interface TweetWhaleTradeBody {
  whaleAddress: string;
  amount: number | string;
  marketName: string;
  side: string;
}

const TWITTER_CREDENTIAL_KEYS = [
  "X_API_KEY",
  "X_API_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_TOKEN_SECRET",
] as const;

type TwitterCredentialKey = (typeof TWITTER_CREDENTIAL_KEYS)[number];

function isAuthorized(request: NextRequest): boolean {
  const configuredSecret = process.env.BOT_API_SECRET;
  if (!configuredSecret) return false;

  const providedSecret = request.headers.get("x-bot-secret");
  return providedSecret === configuredSecret;
}

function maskEnvValue(value: string | undefined): string {
  if (!value) return "(missing)";
  return `${value.substring(0, 4)}...`;
}

function logMaskedCredentials(): void {
  console.log("[api/tweet-whale-trade] Credential prefixes:", {
    X_API_KEY: maskEnvValue(process.env.X_API_KEY),
    X_API_SECRET: maskEnvValue(process.env.X_API_SECRET),
    X_ACCESS_TOKEN: maskEnvValue(process.env.X_ACCESS_TOKEN),
    X_ACCESS_TOKEN_SECRET: maskEnvValue(process.env.X_ACCESS_TOKEN_SECRET),
  });
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

  const missing = TWITTER_CREDENTIAL_KEYS.filter(
    (key) => !values[key]?.trim()
  );

  if (missing.length > 0) {
    console.error(
      "[api/tweet-whale-trade] Missing or empty Twitter credentials:",
      missing
    );
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

function createTwitterOAuthClient(credentials: {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}): TwitterApi {
  return new TwitterApi({
    appKey: credentials.appKey,
    appSecret: credentials.appSecret,
    accessToken: credentials.accessToken,
    accessSecret: credentials.accessSecret,
  });
}

function formatAmount(amount: number | string): string {
  const value = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(value)) return String(amount);
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function formatTweet(payload: TweetWhaleTradeBody): string {
  const amountStr = formatAmount(payload.amount);

  return `🚨 WHALE ALERT 🚨
Address: ${payload.whaleAddress}
Market: ${payload.marketName}
Position: ${payload.side} ($${amountStr})
#WhaleTracker #Crypto`;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as Partial<TweetWhaleTradeBody>;
    const { whaleAddress, amount, marketName, side } = body;

    if (
      !whaleAddress?.trim() ||
      amount == null ||
      !marketName?.trim() ||
      !side?.trim()
    ) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: whaleAddress, amount, marketName, side",
        },
        { status: 400 }
      );
    }

    const credentialCheck = validateTwitterCredentials();
    if (!credentialCheck.ok) {
      return NextResponse.json(
        {
          error: "Twitter API credentials are not configured",
          missing: credentialCheck.missing,
        },
        { status: 503 }
      );
    }

    const client = createTwitterOAuthClient(credentialCheck);
    const text = formatTweet({
      whaleAddress: whaleAddress.trim(),
      amount,
      marketName: marketName.trim(),
      side: side.trim(),
    });

    logMaskedCredentials();
    console.log("[api/tweet-whale-trade] Posting tweet via OAuth 1.0a readWrite client");

    const { data } = await client.readWrite.v2.tweet(text);

    return NextResponse.json({
      success: true,
      tweetId: data.id,
      text: data.text,
    });
  } catch (error) {
    const apiError = error as {
      code?: number;
      data?: unknown;
      message?: string;
    };

    console.error("[api/tweet-whale-trade] Twitter API error:", error);
    console.error("[api/tweet-whale-trade] Twitter API error details:", {
      message: apiError?.message,
      code: apiError?.code,
      data: apiError?.data,
    });

    return NextResponse.json(
      {
        error: "Failed to post tweet",
        message: apiError?.message,
        code: apiError?.code,
        data: apiError?.data,
      },
      { status: 500 }
    );
  }
}
