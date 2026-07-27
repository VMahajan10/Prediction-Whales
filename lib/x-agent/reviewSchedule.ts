const MIN_LEAD_MS = 60_000;

/** Random publish time between 15 and 120 minutes from now. */
export function getRandomScheduledTime(random = Math.random): Date {
  const minMs = 15 * 60 * 1000;
  const maxMs = 120 * 60 * 1000;
  const jitterMs = minMs + random() * (maxMs - minMs);
  return new Date(Date.now() + jitterMs);
}

/** Parse client scheduledAt; falls back to random 15–120 min window. */
export function resolveScheduledAt(
  raw: string | undefined,
  fallback?: Date
): Date {
  const baseFallback = fallback ?? getRandomScheduledTime();

  if (!raw?.trim()) {
    return baseFallback;
  }

  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) {
    return baseFallback;
  }

  const minTime = Date.now() + MIN_LEAD_MS;
  if (parsed.getTime() < minTime) {
    return new Date(minTime);
  }

  return parsed;
}

/** Immediate dispatch — picked up on the next cron tick (≥1 min lead). */
export function resolveImmediateScheduledAt(): Date {
  return new Date(Date.now() + MIN_LEAD_MS);
}
