import type { NextRequest } from "next/server";

/** Read `Authorization: Bearer <token>` (query-string secrets are not supported). */
export function getBearerToken(request: NextRequest): string | null {
  const auth = request.headers.get("authorization")?.trim();
  if (!auth) return null;

  const match = auth.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token || null;
}

/**
 * When `expectedSecret` is unset, allows the request (local/dev).
 * When set, requires a matching Bearer token.
 */
export function authorizeCronRequest(
  request: NextRequest,
  expectedSecret?: string | null
): boolean {
  const expected = expectedSecret?.trim();
  if (!expected) return true;

  const token = getBearerToken(request);
  return token === expected;
}
