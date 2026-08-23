/** Keep-previous-data: a revalidation that yields nothing must not blank the UI. */
export function retainLastNonEmpty<T>(next: T[], previous: T[]): T[] {
  return next.length > 0 ? next : previous;
}

/**
 * Kalshi slots protected from truncation.
 *
 * Polymarket's live socket flow prepends continuously and its trades always
 * carry newer timestamps than the Kalshi backfill, so trimming the tail
 * blindly evicts every hydrated Kalshi row within minutes of page load.
 */
export const KALSHI_BUFFER_FLOOR = 15;

/**
 * Trim the feed buffer to `maxItems` while keeping a floor of Kalshi rows.
 * Retained trades stay in their incoming order.
 */
export function trimFeedBufferWithVenueFloor<
  T extends { source?: string },
>(buffer: T[], maxItems: number, kalshiFloor = KALSHI_BUFFER_FLOOR): T[] {
  if (buffer.length <= maxItems) return buffer;

  const kalshi = buffer.filter((trade) => trade.source === "kalshi");
  const others = buffer.filter((trade) => trade.source !== "kalshi");

  const reserved = Math.min(kalshi.length, kalshiFloor);
  const otherTake = Math.min(others.length, Math.max(maxItems - reserved, 0));
  const kalshiTake = Math.min(kalshi.length, Math.max(maxItems - otherTake, 0));

  const keep = new Set<T>([
    ...others.slice(0, otherTake),
    ...kalshi.slice(0, kalshiTake),
  ]);

  return buffer.filter((trade) => keep.has(trade));
}
