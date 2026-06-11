interface CopyTap {
  marketId: string;
  whaleSize: number;
  verdict: string;
  timestamp: number;
}

const STORAGE_KEY = "marketpulse_copy_taps";

export function trackCopyTap(
  marketId: string,
  whaleSize: number,
  verdict: string
): void {
  try {
    const existing: CopyTap[] = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "[]"
    );
    existing.push({
      marketId,
      whaleSize,
      verdict,
      timestamp: Date.now(),
    });
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(existing.slice(-100))
    );
  } catch {
    // Ignore storage errors
  }
}

export function getCopyStats(): {
  total: number;
  last7days: number;
  avgWhaleSize: number;
  byVerdict: { strong: number; worth: number };
} {
  try {
    const taps: CopyTap[] = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "[]"
    );
    return {
      total: taps.length,
      last7days: taps.filter(
        (t) => Date.now() - t.timestamp < 7 * 86400000
      ).length,
      avgWhaleSize:
        taps.length > 0
          ? Math.round(
              taps.reduce((sum, t) => sum + t.whaleSize, 0) / taps.length
            )
          : 0,
      byVerdict: {
        strong: taps.filter((t) => t.verdict === "Strong Copy Signal").length,
        worth: taps.filter((t) => t.verdict === "Worth Considering").length,
      },
    };
  } catch {
    return { total: 0, last7days: 0, avgWhaleSize: 0, byVerdict: { strong: 0, worth: 0 } };
  }
}
