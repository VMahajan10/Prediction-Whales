import util from "node:util";

const EST_TIMEZONE = "America/New_York";

function toDate(value: Date | string | number): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  return new Date(value < 1_000_000_000_000 ? value * 1000 : value);
}

/** Format a timestamp for display in US Eastern (EST/EDT). */
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

function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => (typeof arg === "string" ? arg : util.format("%o", arg)))
    .join(" ");
}

/** Line-delimited stdout for hosted workers (Render) — avoids console buffering. */
export function logStdout(...args: unknown[]): void {
  process.stdout.write(`${formatLogArgs(args)}\n`);
}

/** Line-delimited stderr for hosted workers (Render) — avoids console buffering. */
export function logStderr(...args: unknown[]): void {
  process.stderr.write(`${formatLogArgs(args)}\n`);
}
