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

const COOLDOWN_MS = 15 * 60 * 1000;
const THROTTLE_MS = 45 * 1000;

interface TweetWhaleTradeBody {
  tradeId?: string;
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

const recentPostCooldowns = new Map<string, number>();
let lastTweetAt = 0;

function pruneCooldowns(now = Date.now()): void {
  for (const [key, expiresAt] of recentPostCooldowns) {
    if (expiresAt <= now) recentPostCooldowns.delete(key);
  }
}

function buildDedupKeys(payload: TweetWhaleTradeBody): string[] {
  const keys: string[] = [];
  const tradeId = payload.tradeId?.trim();
  if (tradeId) keys.push(`trade:${tradeId}`);

  const whaleAddress = payload.whaleAddress.trim();
  const marketName = payload.marketName.trim();
  const side = payload.side.trim();
  const amount = formatAmount(payload.amount);

  keys.push(`details:${whaleAddress}|${marketName}|${side}|${amount}`);

  const addressLower = whaleAddress.toLowerCase();
  if (addressLower && addressLower !== "anonymous" && addressLower !== "unknown") {
    keys.push(`address:${whaleAddress.toLowerCase()}`);
  }

  return keys;
}

function findActiveCooldown(keys: string[]): string | null {
  pruneCooldowns();
  const now = Date.now();
  for (const key of keys) {
    const expiresAt = recentPostCooldowns.get(key);
    if (expiresAt != null && expiresAt > now) return key;
  }
  return null;
}

function registerCooldown(keys: string[]): void {
  const expiresAt = Date.now() + COOLDOWN_MS;
  for (const key of keys) {
    recentPostCooldowns.set(key, expiresAt);
  }
}

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

function isRateLimitError(error: unknown): boolean {
  const apiError = error as { code?: number; status?: number };
  return apiError?.code === 429 || apiError?.status === 429;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as Partial<TweetWhaleTradeBody>;
    const { tradeId, whaleAddress, amount, marketName, side } = body;

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

    const payload: TweetWhaleTradeBody = {
      tradeId: tradeId?.trim(),
      whaleAddress: whaleAddress.trim(),
      amount,
      marketName: marketName.trim(),
      side: side.trim(),
    };

    const dedupKeys = buildDedupKeys(payload);
    const activeCooldownKey = findActiveCooldown(dedupKeys);
    if (activeCooldownKey) {
      console.log(
        "[api/tweet-whale-trade] Skipping duplicate tweet (cooldown active):",
        activeCooldownKey
      );
      return NextResponse.json({
        skipped: true,
        reason: "Cooldown active",
      });
    }

    const now = Date.now();
    const elapsedSinceLastTweet = now - lastTweetAt;
    if (lastTweetAt > 0 && elapsedSinceLastTweet < THROTTLE_MS) {
      const retryAfterMs = THROTTLE_MS - elapsedSinceLastTweet;
      console.warn(
        `[api/tweet-whale-trade] Throttled: last tweet ${elapsedSinceLastTweet}ms ago; retry in ${retryAfterMs}ms`
      );
      return NextResponse.json({
        skipped: true,
        reason: "Throttle active",
        retryAfterMs,
      });
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
    const text = formatTweet(payload);

    logMaskedCredentials();
    console.log("[api/tweet-whale-trade] Posting tweet via OAuth 1.0a readWrite client");

    const { data } = await client.readWrite.v2.tweet(text);

    registerCooldown(dedupKeys);
    lastTweetAt = Date.now();

    return NextResponse.json({
      success: true,
      tweetId: data.id,
      text: data.text,
    });
  } catch (error) {
    if (isRateLimitError(error)) {
      console.warn("[api/tweet-whale-trade] X rate limit reached (429)");
      return NextResponse.json({
        success: false,
        rateLimited: true,
        message: "X Rate limit reached. Waiting for reset.",
      });
    }

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
