import { describe, expect, it } from "vitest";
import {
  buildWhaleReceiptData,
  formatAvgEvPercent,
  formatCentsLabel,
  formatUsdStake,
  formatWinRatePercent,
} from "@/lib/x-agent/generateWhaleReceiptPng";

describe("whaleReceiptImage", () => {
  it("formats receipt labels", () => {
    expect(formatUsdStake(25000)).toBe("$25,000");
    expect(formatCentsLabel(64.2)).toBe("64¢");
    expect(formatWinRatePercent(0.68)).toBe("68%");
    expect(formatAvgEvPercent(0.125)).toBe("+12.5%");
    expect(formatAvgEvPercent(-0.02)).toBe("-2.0%");
  });

  it("builds whale receipt data", () => {
    const receipt = buildWhaleReceiptData(
      {
        marketSlug: "will-team-a-win",
        side: "Team A",
        stakeNotional: 50000,
        entryCents: 64,
        nowCents: 71,
        walletAddress: "0xabc123",
      },
      {
        pseudonym: "Sharp Whale",
        winRate: 0.72,
        avgEv: 0.08,
      }
    );

    expect(receipt.marketTitle).toBe("Will Team A Win");
    expect(receipt.outcomeSide).toBe("Team A");
    expect(receipt.stakeLabel).toBe("$50,000");
    expect(receipt.entryLabel).toBe("64¢");
    expect(receipt.nowLabel).toBe("71¢");
    expect(receipt.winRateLabel).toBe("72%");
    expect(receipt.avgEvLabel).toBe("+8.0%");
    expect(receipt.whaleBadge).toBe("Sharp Whale");
  });
});
