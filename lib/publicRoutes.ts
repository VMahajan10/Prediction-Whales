/** Routes that bypass the demo auth gate and any future auth redirects. */
export const PUBLIC_REVIEW_PATH_PREFIX = "/review/";

const PUBLIC_APP_PATHS = new Set(["/privacy", "/terms"]);

export function isPublicReviewPath(pathname: string): boolean {
  return pathname.startsWith(PUBLIC_REVIEW_PATH_PREFIX);
}

export function isPublicAppPath(pathname: string): boolean {
  return PUBLIC_APP_PATHS.has(pathname) || isPublicReviewPath(pathname);
}
