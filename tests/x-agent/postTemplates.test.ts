import { describe, expect, it } from "vitest";
import {
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
});
