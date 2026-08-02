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

const PRODUCTION_APP_FALLBACK = "https://marketpulse-sand-five.vercel.app";

function isProductionEnvironment(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production"
  );
}

function isLocalhostUrl(url: string): boolean {
  try {
    const normalized = url.startsWith("http://") || url.startsWith("https://")
      ? url
      : `https://${url}`;
    const host = new URL(normalized).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return /localhost|127\.0\.0\.1/i.test(url);
  }
}

function resolveServerAppBaseUrl(): string {
  let baseUrl =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.APP_BASE_URL?.trim() ||
    (process.env.VERCEL_URL?.trim()
      ? `https://${process.env.VERCEL_URL.trim().replace(/^https?:\/\//, "")}`
      : "");

  if (
    baseUrl &&
    !baseUrl.startsWith("http://") &&
    !baseUrl.startsWith("https://")
  ) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl) {
    baseUrl = baseUrl.replace(/\/$/, "");
  }

  if (isProductionEnvironment() && (!baseUrl || isLocalhostUrl(baseUrl))) {
    return PRODUCTION_APP_FALLBACK;
  }

  return baseUrl || "http://localhost:3000";
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
