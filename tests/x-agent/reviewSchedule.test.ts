import { describe, expect, it } from "vitest";
import { POST_STATUS, isDraftQueueStatus } from "@/lib/x-agent/postStatus";
import {
  buildScheduleApprovalApiMessage,
  buildScheduleApprovalUiMessage,
  formatScheduledClockTime,
} from "@/lib/x-agent/scheduleMessages";
import {
  getRandomScheduledTime,
  resolveImmediateScheduledAt,
  resolveScheduledAt,
} from "@/lib/x-agent/reviewSchedule";

describe("postStatus", () => {
  it("treats reviewable queue rows as draft", () => {
    expect(isDraftQueueStatus("PENDING_REVIEW")).toBe(true);
    expect(isDraftQueueStatus("EDITED")).toBe(true);
    expect(isDraftQueueStatus(POST_STATUS.DRAFT)).toBe(true);
    expect(isDraftQueueStatus(POST_STATUS.SCHEDULED)).toBe(false);
  });
});

describe("reviewSchedule", () => {
  it("random schedule is between 15 and 120 minutes", () => {
    const scheduled = getRandomScheduledTime(() => 0);
    const delta = scheduled.getTime() - Date.now();
    expect(delta).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(delta).toBeLessThanOrEqual(120 * 60 * 1000 + 1000);
  });

  it("parses custom scheduledAt with minimum lead time", () => {
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const resolved = resolveScheduledAt(future);
    expect(resolved.getTime()).toBeGreaterThan(Date.now());
  });

  it("immediate schedule is within ~2 minutes", () => {
    const immediate = resolveImmediateScheduledAt();
    const delta = immediate.getTime() - Date.now();
    expect(delta).toBeGreaterThanOrEqual(60_000);
    expect(delta).toBeLessThan(120_000);
  });
});

describe("scheduleMessages", () => {
  it("builds API and UI approval messages", () => {
    const scheduledAt = new Date("2026-07-27T21:42:00.000Z");
    const clock = formatScheduledClockTime(scheduledAt);
    expect(buildScheduleApprovalApiMessage(scheduledAt)).toBe(
      `Approved! Scheduled for X at ${clock}.`
    );
    expect(buildScheduleApprovalUiMessage(scheduledAt)).toBe(
      `Approved! Scheduled for X at ${clock}.`
    );
  });
});
