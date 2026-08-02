/** Production default when RENDER_EXTERNAL_URL / APP_URL are unset (local scripts). */
export const DEFAULT_APP_URL = "https://mvp-2324.onrender.com";

/**
 * Resolve the public app origin for queue action links and server-side fetches.
 * Priority: RENDER_EXTERNAL_URL → APP_URL → DEFAULT_APP_URL
 */
export function getAppBaseUrl(): string {
  const renderExternal = process.env.RENDER_EXTERNAL_URL?.trim();
  if (renderExternal) return renderExternal.replace(/\/$/, "");

  const appUrl = process.env.APP_URL?.trim();
  if (appUrl) return appUrl.replace(/\/$/, "");

  return DEFAULT_APP_URL;
}

/** Client-facing origin for review links (NEXT_PUBLIC_APP_URL → getAppBaseUrl). */
export function getPublicAppUrl(): string {
  const publicUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (publicUrl) return publicUrl.replace(/\/$/, "");
  return getAppBaseUrl();
}

/**
 * Resolve an absolute URL for same-origin API routes.
 * Browser: current origin. Server/worker: env-based app URL.
 */
export function resolveAppApiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (typeof window !== "undefined" && window.location?.origin) {
    return new URL(normalizedPath, window.location.origin).toString();
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    process.env.APP_BASE_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    getAppBaseUrl() ||
    "http://localhost:3000";

  return new URL(normalizedPath, baseUrl.replace(/\/$/, "")).toString();
}
