import { describe, expect, it } from "vitest";
import { FeedRouteTimer } from "@/lib/feed/feedRouteTiming";

describe("FeedRouteTimer", () => {
  it("records stage marks and total elapsed time", async () => {
    const timer = new FeedRouteTimer();
    await new Promise((resolve) => setTimeout(resolve, 5));
    timer.mark("venuesFetched");
    const breakdown = timer.breakdown();
    expect(breakdown.venuesFetched).toBeGreaterThanOrEqual(4);
    expect(breakdown.totalMs).toBeGreaterThanOrEqual(breakdown.venuesFetched!);
  });
});
