import { describe, expect, it } from "vitest";
import {
  formatExplicitNoOutcome,
  sanitizeTemplateSide,
} from "@/lib/x-agent/sideSanitizer";
import { translateMarketAndSide } from "@/lib/x-agent/translator";

describe("sanitizeTemplateSide", () => {
  it("strips bought yes/no verb prefixes", () => {
    expect(sanitizeTemplateSide("bought no. San Diego FC")).toBe("San Diego FC");
    expect(sanitizeTemplateSide("bought yes")).toBeNull();
    expect(sanitizeTemplateSide("sold no")).toBeNull();
  });

  it("rejects run-on market descriptions", () => {
    expect(
      sanitizeTemplateSide(
        "San Diego FC is competing in a match against LA Galaxy this weekend"
      )
    ).toBeNull();
  });

  it("accepts short named outcomes", () => {
    expect(sanitizeTemplateSide("San Diego FC")).toBe("San Diego FC");
    expect(sanitizeTemplateSide("Portugal")).toBe("Portugal");
  });
});

describe("formatExplicitNoOutcome", () => {
  it("formats explicit NO labels within length limits", () => {
    expect(formatExplicitNoOutcome("San Diego FC")).toBe("San Diego FC (NO)");
  });
});

describe("translateMarketAndSide", () => {
  it("returns named sides for matchups instead of bought yes/no", () => {
    expect(
      translateMarketAndSide({
        source: "polymarket",
        title: "Spain vs Portugal",
        outcome: "prt",
        side: "BUY",
        slug: "fifwc-prt-esp-2026-07-22-prt",
      })
    ).toEqual({
      side: "Portugal",
      marketPlain: "Spain vs Portugal",
    });
  });

  it("fails closed on fallback-style long market descriptions", () => {
    expect(
      translateMarketAndSide({
        source: "polymarket",
        title: "Will San Diego FC win the Western Conference?",
        outcome: "No",
        side: "BUY",
      })
    ).toBeNull();
  });

  it("maps San Diego FC matchup NO to the opposing named side", () => {
    const result = translateMarketAndSide({
      source: "polymarket",
      title: "LA Galaxy vs San Diego FC",
      outcome: "No",
      side: "BUY",
      slug: "mls-lag-sdg-2026-08-09-lag",
    });

    expect(result?.side).toBe("San Diego FC");
    expect(result?.marketPlain).toBe("LA Galaxy vs San Diego FC");
  });
});
