import { describe, expect, it } from "vitest";
import {
  buildEvParenthetical,
  buildTraderAvgEvClause,
  formatTradeEvLabel,
  formatTraderAvgEvLabel,
  getEligibleTemplateFamilies,
  sanitizePostDraft,
  selectPostTemplate,
  selectResolutionReceiptTemplate,
  TEMPLATE_FAMILIES,
} from "@/lib/templates/postTemplates";

function baseInputs(
  overrides: Record<string, unknown> = {}
) {
  return {
    whale: "DeepWallet",
    side: "buy yes",
    entry: 35,
    now: 42,
    avg_ev: 0.08,
    marketPlain: "China invade Taiwan",
    stakeNotional: 30_000,
    avgStakeNotional: 20_000,
    postedCount30d: 3,
    resolvedBetsCount: 512,
    winRate: 0.61,
    ...overrides,
  };
}

describe("selectPostTemplate", () => {
  it("never repeats the same family back-to-back", () => {
    let lastFamily: string | undefined;
    for (let i = 0; i < 12; i += 1) {
      const selection = selectPostTemplate(baseInputs(), {
        lastTemplateFamily: lastFamily,
        random: () => 0,
      });
      if (lastFamily) {
        expect(selection.templateFamily).not.toBe(lastFamily);
      }
      lastFamily = selection.templateFamily;
    }
  });

  it("selects V8 only for resolution receipts", () => {
    const live = getEligibleTemplateFamilies(baseInputs());
    expect(live).not.toContain("V8");

    const receipt = getEligibleTemplateFamilies(
      baseInputs({ gainCents: 36 }),
      { resolutionReceipt: true }
    );
    expect(receipt).toEqual(["V8"]);

    const selection = selectResolutionReceiptTemplate(
      baseInputs({ gainCents: 36 }),
      { random: () => 0 }
    );
    expect(selection.templateFamily).toBe("V8");
    expect(selection.variantId.startsWith("V8-")).toBe(true);
  });

  it("sanitizes URLs and siren emojis", () => {
    const dirty = sanitizePostDraft(
      "🚨 Check https://evil.com now #WhaleTracker #crypto"
    );
    expect(dirty).not.toContain("🚨");
    expect(dirty).not.toContain("https://");
    expect(dirty.toLowerCase()).not.toContain("#crypto");
  });

  it("returns family, variant, and rendered draft", () => {
    const selection = selectPostTemplate(baseInputs(), { random: () => 0 });
    expect(TEMPLATE_FAMILIES).toContain(selection.templateFamily);
    expect(selection.variantId).toMatch(/^V\d+-/);
    expect(selection.renderedDraft.length).toBeGreaterThan(0);
  });

  it("appends optional market context to the rendered draft", () => {
    const selection = selectPostTemplate(
      baseInputs({ context: "Both teams enter on a five-game win streak." }),
      { random: () => 0 }
    );
    expect(selection.renderedDraft).toContain(
      "Both teams enter on a five-game win streak."
    );
  });

  it("formats Trade EV and Trader Avg EV labels distinctly", () => {
    expect(formatTradeEvLabel(5.2)).toBe("Trade EV: +5.2%");
    expect(formatTraderAvgEvLabel(0.08)).toBe("Trader Avg EV: +8%");
    expect(
      buildTraderAvgEvClause({ avg_ev: 0.08, resolvedBetsCount: 512 })
    ).toBe("Trader Avg EV: +8% over 512 bets");
    expect(
      buildTraderAvgEvClause({ avg_ev: 0.08, resolvedBetsCount: 99 })
    ).toBeNull();
    expect(
      buildEvParenthetical({
        tradeEvLabel: "Trade EV: +5.2%",
        traderAvgEvClause: "Trader Avg EV: +8% over 512 bets",
      })
    ).toBe(
      "(Trade EV: +5.2% · Trader Avg EV: +8% over 512 bets)"
    );
    expect(
      buildEvParenthetical({
        tradeEvLabel: "Trade EV: +5.2%",
        traderAvgEvClause: null,
      })
    ).toBe("(Trade EV: +5.2%)");
  });

  it("renders V5-b with explicit trade and trader EV labels", () => {
    let v5bDraft: string | null = null;
    for (let seed = 0; seed < 50; seed += 1) {
      const selection = selectPostTemplate(
        baseInputs({
          entry: 35,
          now: undefined,
          postedCount30d: 0,
          avgStakeNotional: undefined,
          tradeEvPercent: 5.2,
          resolvedBetsCount: 512,
        }),
        {
          lastTemplateFamily: "V6",
          random: () => seed / 50,
        }
      );
      if (selection.templateFamily === "V5" && selection.variantId === "V5-b") {
        v5bDraft = selection.renderedDraft;
        break;
      }
    }

    expect(v5bDraft).not.toBeNull();
    expect(v5bDraft).toMatch(
      /^The crowd has this at \d+¢\. A whale took .+ with \$[\d.,kM]+ \(Trade EV: \+5\.2% · Trader Avg EV: \+8% over 512 bets\)\./
    );
  });

  it("omits Trader Avg EV from V5-b when resolved bets are below 100", () => {
    let v5bDraft: string | null = null;
    for (let seed = 0; seed < 50; seed += 1) {
      const selection = selectPostTemplate(
        baseInputs({
          entry: 35,
          now: undefined,
          postedCount30d: 0,
          avgStakeNotional: undefined,
          tradeEvPercent: 4,
          resolvedBetsCount: 50,
        }),
        {
          lastTemplateFamily: "V6",
          random: () => seed / 50,
        }
      );
      if (selection.templateFamily === "V5" && selection.variantId === "V5-b") {
        v5bDraft = selection.renderedDraft;
        break;
      }
    }

    expect(v5bDraft).not.toBeNull();
    expect(v5bDraft).toContain("(Trade EV: +4%)");
    expect(v5bDraft).not.toContain("Trader Avg EV");
  });
});
