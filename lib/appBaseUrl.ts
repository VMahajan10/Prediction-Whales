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

type BrowserGlobal = {
  window?: {
    location?: {
      origin?: string;
    };
  };
};

/** Read `window.location.origin` without referencing the global `window` identifier. */
function getBrowserOrigin(): string | null {
  if (typeof globalThis === "undefined") return null;

  const origin = (globalThis as BrowserGlobal).window?.location?.origin;
  return typeof origin === "string" && origin.length > 0 ? origin : null;
}

function resolveServerAppBaseUrl(): string {
  const fromPublic = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (fromPublic) return fromPublic.replace(/\/$/, "");

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) return `https://${vercelUrl.replace(/^https?:\/\//, "")}`;

  const appBaseUrl = process.env.APP_BASE_URL?.trim();
  if (appBaseUrl) return appBaseUrl.replace(/\/$/, "");

  return "http://localhost:3000";
}

/**
 * Resolve an absolute URL for same-origin API routes.
 * Browser: current origin. Server/worker: env-based app URL.
 */
export function resolveAppApiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  const browserOrigin = getBrowserOrigin();
  if (browserOrigin) {
    return new URL(normalizedPath, browserOrigin).toString();
  }

  const baseUrl = resolveServerAppBaseUrl();
  return new URL(normalizedPath, baseUrl).toString();
}
