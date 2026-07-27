/** Routes that bypass the demo auth gate and any future auth redirects. */
export const PUBLIC_REVIEW_PATH_PREFIX = "/review/";

export function isPublicReviewPath(pathname: string): boolean {
  return pathname.startsWith(PUBLIC_REVIEW_PATH_PREFIX);
}
