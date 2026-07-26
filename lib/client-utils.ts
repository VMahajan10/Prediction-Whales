const EST_TIMEZONE = "America/New_York";

function toDate(value: Date | string | number): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  return new Date(value < 1_000_000_000_000 ? value * 1000 : value);
}

/** Format a timestamp for display in US Eastern (EST/EDT). Safe for client bundles. */
export function formatToEST(date: Date | string | number): string {
  const parsed = toDate(date);
  if (Number.isNaN(parsed.getTime())) return "Invalid date";

  return parsed.toLocaleString("en-US", {
    timeZone: EST_TIMEZONE,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

export function getTimeAgo(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 0) return "just now";
  if (diff < 60) return `${diff} seconds ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  return `${Math.floor(diff / 86400)} days ago`;
}

export function formatTradeTimeLocal(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString("en-US", {
    timeZone: EST_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}
