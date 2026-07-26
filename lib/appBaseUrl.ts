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
