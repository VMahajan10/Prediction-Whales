import { formatToEST } from "@/lib/utils";

export function getTimeAgo(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 0) return "just now";
  if (diff < 60) return `${diff} seconds ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  return `${Math.floor(diff / 86400)} days ago`;
}

/** Full trade timestamp in US Eastern (EST/EDT). */
export function getFullDate(timestamp: number): string {
  return formatToEST(timestamp);
}

/** @deprecated Prefer getFullDate — kept for callers that expect a UTC label. */
export function getUtcString(timestamp: number): string {
  return formatToEST(timestamp);
}

export function formatTradeTimeLocal(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}
