export type FeedRouteTimingBreakdown = Record<string, number>;

export class FeedRouteTimer {
  private readonly startedAt = Date.now();
  private readonly marks = new Map<string, number>();

  mark(label: string): void {
    this.marks.set(label, Date.now() - this.startedAt);
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  breakdown(): FeedRouteTimingBreakdown {
    const out: FeedRouteTimingBreakdown = {};
    for (const [label, ms] of this.marks) {
      out[label] = ms;
    }
    out.totalMs = this.elapsedMs();
    return out;
  }
}
