/**
 * Canonical X / Twitter OAuth 1.0a credential env var names.
 * Resolution accepts legacy TWITTER_* and alternate X_* aliases (see resolveTwitterCredentials).
 */
export const TWITTER_CREDENTIAL_CANONICAL_KEYS = [
  "X_API_KEY",
  "X_API_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_TOKEN_SECRET",
] as const;

export type TwitterCredentialCanonicalKey =
  (typeof TWITTER_CREDENTIAL_CANONICAL_KEYS)[number];

export interface ResolvedTwitterCredentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

function readFirstEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Resolve X/Twitter OAuth credentials from any supported env var alias. */
export function resolveTwitterCredentials():
  | ({ ok: true } & ResolvedTwitterCredentials)
  | { ok: false; missing: TwitterCredentialCanonicalKey[] } {
  const appKey = readFirstEnv(
    "X_API_KEY",
    "TWITTER_API_KEY",
    "X_CONSUMER_KEY",
    "TWITTER_CONSUMER_KEY"
  );
  const appSecret = readFirstEnv(
    "X_API_SECRET",
    "TWITTER_API_SECRET",
    "X_CONSUMER_SECRET",
    "TWITTER_CONSUMER_SECRET"
  );
  const accessToken = readFirstEnv("X_ACCESS_TOKEN", "TWITTER_ACCESS_TOKEN");
  const accessSecret = readFirstEnv(
    "X_ACCESS_TOKEN_SECRET",
    "X_ACCESS_SECRET",
    "TWITTER_ACCESS_TOKEN_SECRET",
    "TWITTER_ACCESS_SECRET"
  );

  const missing: TwitterCredentialCanonicalKey[] = [];
  if (!appKey) missing.push("X_API_KEY");
  if (!appSecret) missing.push("X_API_SECRET");
  if (!accessToken) missing.push("X_ACCESS_TOKEN");
  if (!accessSecret) missing.push("X_ACCESS_TOKEN_SECRET");

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    appKey: appKey!,
    appSecret: appSecret!,
    accessToken: accessToken!,
    accessSecret: accessSecret!,
  };
}

export function isTwitterCredentialsConfigured(): boolean {
  return resolveTwitterCredentials().ok;
}
