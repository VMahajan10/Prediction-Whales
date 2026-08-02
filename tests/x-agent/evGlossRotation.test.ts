import { describe, expect, it } from "vitest";
import {
  EV_GLOSSES,
  formatBoundAvgEv,
  selectEvGloss,
} from "@/constants/evGlosses";
import { selectPostTemplate } from "@/lib/templates/postTemplates";

function baseInputs(overrides: Record<string, unknown> = {}) {
  return {
    whale: "DeepWallet",
    side: "bought yes",
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

describe("selectEvGloss", () => {
  it("never returns the excluded gloss when alternatives exist", () => {
    for (const excluded of EV_GLOSSES) {
      const gloss = selectEvGloss({
        excludeGloss: excluded,
        random: () => 0,
      });
      expect(gloss).not.toBe(excluded);
    }
  });

  it("falls back to the full pool when exclude is unknown", () => {
    expect(
      selectEvGloss({ excludeGloss: "not a real gloss", random: () => 0 })
    ).toBe(EV_GLOSSES[0]);
  });
});

describe("formatBoundAvgEv", () => {
  it("always pairs AVG EV percent with the gloss phrase", () => {
    expect(formatBoundAvgEv(0.12, "profitable on average")).toBe(
      "+12% AVG EV — profitable on average"
    );
  });
});

describe("selectPostTemplate EV gloss rotation", () => {
  it("excludes the prior gloss when selecting the next draft gloss", () => {
    const selection = selectPostTemplate(baseInputs(), {
      lastEvGloss: "profitable on average",
      random: () => 0,
    });

    expect(selection.evGloss).not.toBe("profitable on average");
  });

  it("still returns an evGloss token for downstream persistence", () => {
    const selection = selectPostTemplate(baseInputs(), { random: () => 0 });
    expect(selection.evGloss.length).toBeGreaterThan(0);
  });
});
