/** Production default when APP_URL / NEXT_PUBLIC_APP_URL are unset. */
export const DEFAULT_APP_URL = "https://mvp-2324.onrender.com";

/**
 * Resolve the public app origin for action links, webhooks, and server-side fetches.
 * Priority: APP_URL → NEXT_PUBLIC_APP_URL → VERCEL_URL → DEFAULT_APP_URL
 */
export function getAppBaseUrl(): string {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const nextPublic = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (nextPublic) return nextPublic.replace(/\/$/, "");

  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel}`;

  return DEFAULT_APP_URL;
}
