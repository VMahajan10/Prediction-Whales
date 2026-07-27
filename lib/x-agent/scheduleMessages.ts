const EST_TIMEZONE = "America/New_York";

function toDate(value: Date | string | number): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  return new Date(value);
}

function estDateKey(date: Date): string {
  return date.toLocaleDateString("en-US", { timeZone: EST_TIMEZONE });
}

export function isTodayInEST(date: Date | string | number): boolean {
  const parsed = toDate(date);
  if (Number.isNaN(parsed.getTime())) return false;
  return estDateKey(parsed) === estDateKey(new Date());
}

/** e.g. "5:42 PM EST" */
export function formatScheduledClockTime(
  date: Date | string | number
): string {
  const parsed = toDate(date);
  if (Number.isNaN(parsed.getTime())) return "Invalid time";

  const time = parsed.toLocaleString("en-US", {
    timeZone: EST_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return `${time} EST`;
}

/** e.g. "today at 5:42 PM EST" or "Mon, Mar 10 at 5:42 PM EST" */
export function formatScheduledTimeLabel(date: Date | string | number): string {
  const parsed = toDate(date);
  if (Number.isNaN(parsed.getTime())) return "Invalid date";

  const clock = formatScheduledClockTime(parsed);

  if (isTodayInEST(parsed)) {
    return `today at ${clock}`;
  }

  const day = parsed.toLocaleDateString("en-US", {
    timeZone: EST_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  return `${day} at ${clock}`;
}

export function buildScheduleApprovalApiMessage(
  scheduledAt: Date | string | number
): string {
  const clock = formatScheduledClockTime(scheduledAt);
  return `Approved! Scheduled for X at ${clock}.`;
}

export function buildScheduleApprovalUiMessage(
  scheduledAt: Date | string | number
): string {
  return buildScheduleApprovalApiMessage(scheduledAt);
}
