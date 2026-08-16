import "server-only";

import type { NextRequest } from "next/server";
import { checkIpRateLimit } from "@/lib/rateLimit/ipRateLimit";

const WHALES_NOTIFY_LIMIT = 10;
const WHALES_NOTIFY_WINDOW_SEC = 60;
const WHALES_NOTIFY_KEY_PREFIX = "ratelimit:whales-notify:";

/** Best-effort client IP for Vercel / reverse-proxy deployments. */
export function resolveWhalesNotifyClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  return "unknown";
}

/** 10 requests/min per IP for `/api/whales/notify`. */
export async function checkWhalesNotifyRateLimit(
  request: NextRequest
): Promise<ReturnType<typeof checkIpRateLimit>> {
  const ip = resolveWhalesNotifyClientIp(request);
  return checkIpRateLimit(
    `${WHALES_NOTIFY_KEY_PREFIX}${ip}`,
    WHALES_NOTIFY_LIMIT,
    WHALES_NOTIFY_WINDOW_SEC
  );
}
