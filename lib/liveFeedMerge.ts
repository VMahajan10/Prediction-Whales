import type { LiveFeedPlatform } from "@/lib/liveFeedPlatform";

export const MAX_FEED_ITEMS = 50;
const KALSHI_SLOTS = 20;
const PM_SLOTS = 30;

function interleave<T>(pm: T[], kalshi: T[], maxItems: number): T[] {
  const result: T[] = [];
  let pi = 0;
  let ki = 0;
  let pos = 0;

  while (result.length < maxItems && (pi < pm.length || ki < kalshi.length)) {
    const wantKalshi = pos % 3 === 2;
    if (wantKalshi && ki < kalshi.length) {
      result.push(kalshi[ki++]);
    } else if (pi < pm.length) {
      result.push(pm[pi++]);
    } else if (ki < kalshi.length) {
      result.push(kalshi[ki++]);
    }
    pos++;
  }

  return result;
}

export function mergeWithReservedSlots<T>(
  pm: T[],
  kalshi: T[],
  sortFn: (a: T, b: T) => number,
  maxItems = MAX_FEED_ITEMS
): T[] {
  const pmSorted = [...pm].sort(sortFn);
  const kalshiSorted = [...kalshi].sort(sortFn);

  const kalshiTake = kalshiSorted.slice(0, KALSHI_SLOTS);
  const pmTake = pmSorted.slice(0, PM_SLOTS);

  const kalshiShort = KALSHI_SLOTS - kalshiTake.length;
  const pmShort = PM_SLOTS - pmTake.length;

  const pmFinal = pmSorted.slice(0, PM_SLOTS + kalshiShort);
  const kalshiFinal = kalshiSorted.slice(0, KALSHI_SLOTS + pmShort);

  return interleave(pmFinal, kalshiFinal, maxItems);
}

export function buildPlatformFeed<T>(
  pm: T[],
  kalshi: T[],
  platform: LiveFeedPlatform,
  sortFn: (a: T, b: T) => number,
  maxItems = MAX_FEED_ITEMS
): T[] {
  if (platform === "polymarket") {
    return [...pm].sort(sortFn).slice(0, maxItems);
  }
  if (platform === "kalshi") {
    return [...kalshi].sort(sortFn).slice(0, maxItems);
  }
  return mergeWithReservedSlots(pm, kalshi, sortFn, maxItems);
}

export function liveFeedPlatformLabel(platform: LiveFeedPlatform): string {
  if (platform === "polymarket") return "Polymarket only";
  if (platform === "kalshi") return "Kalshi only";
  return "Polymarket + Kalshi";
}
