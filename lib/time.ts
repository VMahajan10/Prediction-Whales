import { formatToEST } from "@/lib/client-utils";

export { formatToEST, formatTradeTimeLocal, getTimeAgo } from "@/lib/client-utils";

/** Full trade timestamp in US Eastern (EST/EDT). */
export function getFullDate(timestamp: number): string {
  return formatToEST(timestamp);
}

/** @deprecated Prefer getFullDate — kept for callers that expect a UTC label. */
export function getUtcString(timestamp: number): string {
  return formatToEST(timestamp);
}
