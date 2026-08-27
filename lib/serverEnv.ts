import { logger } from "@/lib/logger";

/**
 * Server-side env diagnostics for review/login routes.
 * This app uses demo sessionStorage auth — not NextAuth.
 */
export function logReviewRouteEnvStatus(): void {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  logger.debug(
    "⚙️ [Env Check] DATABASE_URL =",
    databaseUrl ? "(set)" : "(not set — review routes need Postgres)"
  );

  const nextAuthSecret = process.env.NEXTAUTH_SECRET?.trim();
  if (nextAuthSecret) {
    logger.debug("⚙️ [Env Check] NEXTAUTH_SECRET = (set, unused — demo auth only)");
  }

  const nextPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  logger.debug(
    "⚙️ [Env Check] NEXT_PUBLIC_APP_URL =",
    nextPublicAppUrl || "(not set — using APP_URL / default)"
  );
}

export function isDatabaseUrlConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}
