import { describe, expect, it } from "vitest";
import {
  getEligibleTemplateFamilies,
  PostTemplateError,
  sanitizePostDraft,
  selectPostTemplate,
  selectResolutionReceiptTemplate,
  TEMPLATE_FAMILIES,
} from "@/lib/templates/postTemplates";

function baseInputs(overrides: Record<string, unknown> = {}) {
  return {
    whale: "DeepWallet",
    side: "Zhizhen Zhang",
    entry: 35,
    now: 42,
    avg_ev: 0.08,
    marketPlain: "to win the Round of 16 match",
    stakeNotional: 52_000,
    avgStakeNotional: 20_000,
    postedCount30d: 3,
    resolvedBetsCount: 1_240,
    winRate: 0.68,
    category: "Champions League",
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

  it("prioritizes V5 → V7 → V3 → V4 → V6 for live trades", () => {
    expect(
      getEligibleTemplateFamilies(
        baseInputs({
          entry: 35,
          now: 42,
          stakeNotional: 52_000,
          avgStakeNotional: 20_000,
          postedCount30d: 3,
        })
      )[0]
    ).toBe("V5");

    expect(
      getEligibleTemplateFamilies(
        baseInputs({
          entry: 52,
          now: 52,
          stakeNotional: 52_000,
          avgStakeNotional: 20_000,
          postedCount30d: 0,
        })
      )[0]
    ).toBe("V7");

    expect(
      getEligibleTemplateFamilies(
        baseInputs({
          entry: 52,
          now: 58,
          stakeNotional: 30_000,
          avgStakeNotional: 20_000,
          postedCount30d: 0,
        })
      )[0]
    ).toBe("V3");

    expect(
      getEligibleTemplateFamilies(
        baseInputs({
          entry: 52,
          now: undefined,
          stakeNotional: 52_000,
          avgStakeNotional: 20_000,
          postedCount30d: 0,
        })
      )[0]
    ).toBe("V4");

    expect(
      getEligibleTemplateFamilies(
        baseInputs({
          entry: 52,
          now: undefined,
          stakeNotional: 30_000,
          avgStakeNotional: 20_000,
          postedCount30d: 3,
          category: "CA politics",
        })
      )[0]
    ).toBe("V6");
  });

  it("formats slots per Templates.md schema", () => {
    // V5-a includes stake, entry, now, and win_rate.
    let draft: string | null = null;
    for (let seed = 0; seed < 40; seed += 1) {
      const selection = selectPostTemplate(
        baseInputs({
          entry: 35,
          now: 42,
          stakeNotional: 52_000,
          avgStakeNotional: 8_000,
          agoMinutes: 8,
          postedCount30d: 0,
          avg_ev: 0.12,
          winRate: 0.68,
          resolvedBetsCount: 1_240,
        }),
        { lastTemplateFamily: "V7", random: () => seed / 40 }
      );
      if (selection.variantId === "V5-a") {
        draft = selection.renderedDraft;
        break;
      }
    }

    expect(draft).not.toBeNull();
    expect(draft).toMatch(/\$52K/);
    expect(draft).toMatch(/35¢/);
    expect(draft).toMatch(/42¢/);
    expect(draft).not.toMatch(/¢¢/);
    expect(draft).toMatch(/68%/);
    expect(draft).not.toMatch(/%%/);

    const conviction = selectPostTemplate(
      baseInputs({
        entry: 64,
        now: undefined,
        stakeNotional: 52_000,
        avgStakeNotional: 8_000,
        postedCount30d: 0,
      }),
      { lastTemplateFamily: "V2", random: () => 0 }
    );
    expect(conviction.templateFamily).toBe("V4");
    expect(conviction.renderedDraft).toMatch(/~\$8K/);
  });

  it("never prints avg_ev without a gloss", () => {
    const selection = selectPostTemplate(
      baseInputs({
        entry: 52,
        now: undefined,
        postedCount30d: 0,
        avgStakeNotional: undefined,
        avg_ev: 0.12,
      }),
      { random: () => 0 }
    );

    if (selection.renderedDraft.includes("+12%")) {
      expect(selection.renderedDraft).toContain(selection.evGloss);
    }
  });

  it("fails closed when required slots are missing", () => {
    expect(() =>
      selectPostTemplate(
        baseInputs({
          whale: "",
        })
      )
    ).toThrow(PostTemplateError);

    expect(() =>
      selectPostTemplate(
        baseInputs({
          whale: "0xabc12345deadbeef",
        })
      )
    ).toThrow(/whale\(named\)/);

    expect(() =>
      selectPostTemplate(
        baseInputs({
          avg_ev: undefined,
          winRate: undefined,
          resolvedBetsCount: undefined,
        })
      )
    ).toThrow(/credibility/);
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

  it("renders strict V5-b copy with gloss-bound AVG EV", () => {
    let v5bDraft: string | null = null;
    let gloss: string | null = null;
    for (let seed = 0; seed < 50; seed += 1) {
      const selection = selectPostTemplate(
        baseInputs({
          entry: 35,
          now: 42,
          postedCount30d: 0,
          avgStakeNotional: undefined,
          resolvedBetsCount: 1_240,
          avg_ev: 0.12,
        }),
        {
          lastTemplateFamily: "V6",
          random: () => seed / 50,
        }
      );
      if (selection.templateFamily === "V5" && selection.variantId === "V5-b") {
        v5bDraft = selection.renderedDraft;
        gloss = selection.evGloss;
        break;
      }
    }

    expect(v5bDraft).not.toBeNull();
    expect(v5bDraft).toContain("The crowd has this at 42¢.");
    expect(v5bDraft).toContain("+12% AVG EV");
    expect(v5bDraft).toContain(gloss!);
    expect(v5bDraft).not.toContain("Trade EV");
    expect(v5bDraft).not.toContain("Trader Avg EV");
  });
});
