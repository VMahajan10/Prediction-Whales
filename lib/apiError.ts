/**
 * Safe error text for JSON API responses — verbose in development, generic in production.
 */
export function publicApiErrorMessage(
  err: unknown,
  fallback = "An unexpected error occurred"
): string {
  if (process.env.NODE_ENV !== "production") {
    return err instanceof Error ? err.message : String(err);
  }
  return fallback;
}
