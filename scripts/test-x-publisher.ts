/**
 * Post a single plain-text tweet to verify X/Twitter API auth and write permissions.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.json scripts/test-x-publisher.ts
 *
 * Required env (from .env / .env.local):
 *   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
 *   (legacy TWITTER_* aliases are also accepted — see lib/twitter/credentials.ts)
 */
import dotenv from "dotenv";
import { TwitterApi } from "twitter-api-v2";
import { resolveTwitterCredentials } from "../lib/twitter/credentials";

dotenv.config({ path: ".env.local", override: false });
dotenv.config({ override: false });

async function runTest(): Promise<void> {
  console.log("🔍 Resolving Twitter credentials...");

  const creds = resolveTwitterCredentials();
  if (!creds.ok) {
    console.error(
      `❌ Missing credentials: ${creds.missing.join(", ")}. Check your .env file.`
    );
    process.exit(1);
  }

  const client = new TwitterApi({
    appKey: creds.appKey,
    appSecret: creds.appSecret,
    accessToken: creds.accessToken,
    accessSecret: creds.accessSecret,
  });

  const testText = `[Test] MarketPulse Publisher Test ${new Date().toISOString()}`;
  console.log(`🚀 Attempting to publish text tweet: "${testText}"`);

  try {
    const res = await client.readWrite.v2.tweet(testText);
    console.log("✅ SUCCESS! Tweet posted successfully:");
    console.log(res);
    process.exit(0);
  } catch (err: unknown) {
    console.error("❌ FAILED to post tweet:");
    if (err instanceof Error) {
      console.error(err.message);
      if (err.cause) console.error(err.cause);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}

void runTest();
