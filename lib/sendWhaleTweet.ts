import { TwitterApi } from "twitter-api-v2";
import {
  resolveTwitterCredentials,
  type TwitterCredentialCanonicalKey,
} from "@/lib/twitter/credentials";

export interface WhaleTweetPayload {
  tradeId?: string;
  whaleAddress: string;
  amount: number | string;
  marketName: string;
  side: string;
}

export type SendWhaleTweetResult =
  | { ok: true; tweetId: string; text?: string }
  | {
      ok: false;
      skipped: true;
      reason: string;
      retryAfterMs?: number;
    }
  | {
      ok: false;
      skipped?: false;
      error: string;
      missingCredentials?: string[];
      rateLimited?: boolean;
      code?: number;
      data?: unknown;
    };

const COOLDOWN_MS = 15 * 60 * 1000;
const THROTTLE_MS = 45 * 1000;

const recentPostCooldowns = new Map<string, number>();
let lastTweetAt = 0;

/** @internal Test hook — bypasses live X API in scripts. */
export const whaleTweetTestHooks = {
  override:
    null as
      | ((payload: WhaleTweetPayload) => Promise<SendWhaleTweetResult>)
      | null,
};

function pruneCooldowns(now = Date.now()): void {
  recentPostCooldowns.forEach((expiresAt, key) => {
    if (expiresAt <= now) {
      recentPostCooldowns.delete(key);
    }
  });
}

function formatAmount(amount: number | string): string {
  const value = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(value)) return String(amount);
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function buildDedupKeys(payload: WhaleTweetPayload): string[] {
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

function validateTwitterCredentials():
  | {
      ok: true;
      appKey: string;
      appSecret: string;
      accessToken: string;
      accessSecret: string;
    }
  | { ok: false; missing: TwitterCredentialCanonicalKey[] } {
  return resolveTwitterCredentials();
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

function buildTweetRef(payload: WhaleTweetPayload): string {
  const tradeId = payload.tradeId?.trim();
  if (tradeId) return tradeId.slice(0, 8);
  return Date.now().toString(36);
}

function formatTweet(payload: WhaleTweetPayload): string {
  const amountStr = formatAmount(payload.amount);
  const ref = buildTweetRef(payload);

  return `🚨 WHALE ALERT 🚨
Address: ${payload.whaleAddress}
Market: ${payload.marketName}
Position: ${payload.side} ($${amountStr})
#WhaleTracker #Crypto

[Ref: ${ref}]`;
}

function isRateLimitError(error: unknown): boolean {
  const apiError = error as { code?: number; status?: number };
  return apiError?.code === 429 || apiError?.status === 429;
}

function isDuplicateTweetError(error: unknown): boolean {
  const apiError = error as {
    code?: number;
    status?: number;
    data?: { detail?: string; title?: string; type?: string };
    message?: string;
  };
  const status = apiError?.code ?? apiError?.status;
  if (status !== 403) return false;

  const haystack = [
    apiError.message,
    apiError.data?.detail,
    apiError.data?.title,
    apiError.data?.type,
    JSON.stringify(apiError.data ?? ""),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    haystack.includes("duplicate") ||
    haystack.includes("already posted") ||
    haystack.includes("status is a duplicate")
  );
}

function normalizePayload(
  payload: WhaleTweetPayload
): WhaleTweetPayload | null {
  const whaleAddress = payload.whaleAddress?.trim();
  const marketName = payload.marketName?.trim();
  const side = payload.side?.trim();

  if (!whaleAddress || payload.amount == null || !marketName || !side) {
    return null;
  }

  return {
    tradeId: payload.tradeId?.trim(),
    whaleAddress,
    amount: payload.amount,
    marketName,
    side,
  };
}

/** Post a whale alert tweet with in-process cooldown and throttle guards. */
export async function sendWhaleTweet(
  payload: WhaleTweetPayload
): Promise<SendWhaleTweetResult> {
  if (whaleTweetTestHooks.override) {
    return whaleTweetTestHooks.override(payload);
  }

  const normalized = normalizePayload(payload);
  if (!normalized) {
    return {
      ok: false,
      error:
        "Missing required fields: whaleAddress, amount, marketName, side",
    };
  }

  const dedupKeys = buildDedupKeys(normalized);
  const activeCooldownKey = findActiveCooldown(dedupKeys);
  if (activeCooldownKey) {
    console.log(
      "[sendWhaleTweet] Skipping duplicate tweet (cooldown active):",
      activeCooldownKey
    );
    return {
      ok: false,
      skipped: true,
      reason:
        normalized.tradeId && activeCooldownKey === `trade:${normalized.tradeId}`
          ? "Trade already tweeted recently"
          : "Cooldown active",
    };
  }

  const now = Date.now();
  const elapsedSinceLastTweet = now - lastTweetAt;
  if (lastTweetAt > 0 && elapsedSinceLastTweet < THROTTLE_MS) {
    const retryAfterMs = THROTTLE_MS - elapsedSinceLastTweet;
    console.warn(
      `[sendWhaleTweet] Throttled: last tweet ${elapsedSinceLastTweet}ms ago; retry in ${retryAfterMs}ms`
    );
    return {
      ok: false,
      skipped: true,
      reason: "Throttle active",
      retryAfterMs,
    };
  }

  const credentialCheck = validateTwitterCredentials();
  if (!credentialCheck.ok) {
    console.error(
      "[sendWhaleTweet] Missing or empty Twitter credentials:",
      credentialCheck.missing
    );
    return {
      ok: false,
      error: "Twitter API credentials are not configured",
      missingCredentials: credentialCheck.missing,
    };
  }

  const client = createTwitterOAuthClient(credentialCheck);
  const text = formatTweet(normalized);

  try {
    console.log("[sendWhaleTweet] Posting tweet via OAuth 1.0a readWrite client");
    const { data } = await client.readWrite.v2.tweet(text);

    registerCooldown(dedupKeys);
    lastTweetAt = Date.now();

    return {
      ok: true,
      tweetId: data.id,
      text: data.text,
    };
  } catch (error) {
    if (isDuplicateTweetError(error)) {
      registerCooldown(dedupKeys);
      console.warn(
        "[sendWhaleTweet] X rejected duplicate content (403) — registering cooldown"
      );
      return {
        ok: false,
        skipped: true,
        reason: "Duplicate tweet content",
      };
    }

    if (isRateLimitError(error)) {
      console.warn("[sendWhaleTweet] X rate limit reached (429)");
      return {
        ok: false,
        error: "X Rate limit reached. Waiting for reset.",
        rateLimited: true,
      };
    }

    const apiError = error as {
      code?: number;
      data?: unknown;
      message?: string;
    };

    console.error("[sendWhaleTweet] Twitter API error:", error);
    console.error("[sendWhaleTweet] Twitter API error details:", {
      message: apiError?.message,
      code: apiError?.code,
      data: apiError?.data,
    });

    return {
      ok: false,
      error: apiError?.message ?? "Failed to post tweet",
      code: apiError?.code,
      data: apiError?.data,
    };
  }
}
