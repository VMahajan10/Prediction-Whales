import { getPublicAppUrl } from "@/lib/appBaseUrl";

/** Allow only same-origin relative paths (blocks open redirects). */
export function sanitizeRedirectPath(path: string | null | undefined): string {
  if (!path?.trim()) return "/";

  const trimmed = path.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return "/";
  if (trimmed.includes("://")) return "/";

  return trimmed;
}

/** `/login?redirectTo=...` for unauthenticated entry to a protected route. */
export function buildLoginUrlWithRedirect(redirectTo: string): string {
  const safePath = sanitizeRedirectPath(redirectTo);
  const params = new URLSearchParams({ redirectTo: safePath });
  return `${getPublicAppUrl()}/login?${params.toString()}`;
}

/** Login URL that lands on the review editor after sign-in. */
export function buildReviewEditLoginUrl(queueId: string): string {
  const reviewPath = `/review/${encodeURIComponent(queueId)}`;
  return buildLoginUrlWithRedirect(reviewPath);
}
