import { describe, expect, it } from "vitest";
import {
  buildDecisionConflictMessage,
  formatReviewDecisionBadge,
  isPendingReviewStatus,
  normalizeDecidedBy,
} from "@/lib/x-agent/reviewDecision";

describe("reviewDecision", () => {
  it("treats pending review statuses as editable", () => {
    expect(isPendingReviewStatus("PENDING_REVIEW")).toBe(true);
    expect(isPendingReviewStatus("EDITED")).toBe(true);
    expect(isPendingReviewStatus("DRAFT")).toBe(true);
    expect(isPendingReviewStatus("SCHEDULED")).toBe(false);
    expect(isPendingReviewStatus("KILLED")).toBe(false);
  });

  it("builds the standardized 409 conflict message", () => {
    expect(buildDecisionConflictMessage("Vaibhav")).toBe(
      "This trade decision has already been finalized by Vaibhav."
    );
    expect(buildDecisionConflictMessage(null)).toBe(
      "This trade decision has already been finalized by another cofounder."
    );
  });

  it("formats decision badges for reject and schedule outcomes", () => {
    const decidedAt = "2026-07-29T18:00:00.000Z";
    expect(
      formatReviewDecisionBadge("KILLED", "Vaibhav", decidedAt)
    ).toContain("Rejected by Vaibhav");
    expect(
      formatReviewDecisionBadge("SCHEDULED", "Vaibhav", decidedAt)
    ).toContain("Scheduled by Vaibhav");
    expect(formatReviewDecisionBadge("PENDING_REVIEW", "Vaibhav", decidedAt)).toBe(
      null
    );
  });

  it("normalizes empty decider names", () => {
    expect(normalizeDecidedBy("")).toBe("Review page");
    expect(normalizeDecidedBy("Vaibhav")).toBe("Vaibhav");
  });
});
