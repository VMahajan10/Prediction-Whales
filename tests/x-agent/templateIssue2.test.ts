import { describe, expect, it, vi } from "vitest";
import {
  getEligibleTemplateFamilies,
  PostTemplateError,
  REPEAT_CHARACTER_MIN_POSTED_COUNT,
  selectPostTemplate,
  CONTRARIAN_MAX_ENTRY_CENTS,
} from "@/lib/templates/postTemplates";
import { renderVariantCopy } from "@/lib/templates/templateRender";
import { TEMPLATE_FAMILY_COPY_DEFAULTS } from "@/lib/templates/templateCopyDefaults";

const TEMPLATE_COPY_BY_FAMILY = new Map(
  TEMPLATE_FAMILY_COPY_DEFAULTS.map((def) => [def.family, def])
);

function baseInputs(overrides: Record<string, unknown> = {}) {
  return {
    whale: "DeepWallet",
    side: "Zhizhen Zhang",
    entry: 35,
    now: 42,
    avg_ev: 0.08,
    marketPlain: "Champions League",
    stakeNotional: 52_000,
    avgStakeNotional: 20_000,
    postedCount30d: 0,
    resolvedBetsCount: 1_240,
    winRate: 0.68,
    category: "Champions League",
    ...overrides,
  };
}

describe("V6 posted count threshold", () => {
  it("uses >= 2 published posts per Templates.md", () => {
    expect(REPEAT_CHARACTER_MIN_POSTED_COUNT).toBe(2);
    expect(
      getEligibleTemplateFamilies(
        baseInputs({ postedCount30d: 1, entry: 52, now: undefined })
      )
    ).not.toContain("V6");
    expect(
      getEligibleTemplateFamilies(
        baseInputs({
          postedCount30d: 2,
          entry: 52,
          now: undefined,
          avgStakeNotional: undefined,
        })
      )[0]
    ).toBe("V6");
  });
});

describe("V5 contrarian eligibility", () => {
  it("qualifies under 40¢ entry without requiring line movement", () => {
    const eligible = getEligibleTemplateFamilies(
      baseInputs({
        entry: 35,
        now: 35,
        postedCount30d: 0,
        avgStakeNotional: undefined,
      })
    );
    expect(eligible[0]).toBe("V5");
    expect(CONTRARIAN_MAX_ENTRY_CENTS).toBe(40);
  });
});

describe("V4 stake-history eligibility", () => {
  it("qualifies when avg stake history exists (not 2x heuristic)", () => {
    const eligible = getEligibleTemplateFamilies(
      baseInputs({
        entry: 64,
        now: undefined,
        stakeNotional: 5_000,
        avgStakeNotional: 8_000,
        postedCount30d: 0,
      })
    );
    expect(eligible).toContain("V4");
  });

  it("does not qualify without stake history", () => {
    const eligible = getEligibleTemplateFamilies(
      baseInputs({
        entry: 64,
        now: undefined,
        avgStakeNotional: undefined,
        postedCount30d: 0,
      })
    );
    expect(eligible).not.toContain("V4");
  });
});

describe("anonymous fail-closed", () => {
  it("throws when anonymousWhale is set", () => {
    expect(() =>
      selectPostTemplate(
        baseInputs({ anonymousWhale: true }),
        { random: () => 0 }
      )
    ).toThrow(PostTemplateError);
  });
});

describe("variant rotation", () => {
  it("never repeats the same variant id back-to-back", () => {
    const inputs = baseInputs({
      entry: 52,
      now: 52,
      postedCount30d: 0,
      avgStakeNotional: undefined,
    });
    let lastVariant: string | undefined;
    for (let i = 0; i < 20; i += 1) {
      const selection = selectPostTemplate(inputs, {
        lastVariantId: lastVariant,
        random: () => i / 20,
      });
      if (lastVariant) {
        expect(selection.variantId).not.toBe(lastVariant);
      }
      lastVariant = selection.variantId;
    }
  });
});

describe("sentence-order rotation", () => {
  it("rotates sentences deterministically without changing words", () => {
    const v3b = TEMPLATE_COPY_BY_FAMILY.get("V3")!.variants.find(
      (v) => v.id === "b"
    )!;
    const slots = {
      whale: "DeepWallet",
      side: "Zhizhen Zhang",
      entry: "52¢",
      now: "58¢",
      stake: "$52K",
      avgEv: "+12%",
      winRate: "68%",
      resolved: "1,240",
      postedCount: "2",
      avgStake: "~$8K",
      ago: "8 min",
      gain: "+36¢",
      category: "Champions League",
      evGloss: "profitable on average",
      evGlossThey: "win at the right price",
      evGlossProgressive: "winning at the right price",
      repeatOrdinal: "Third",
      hashtag: "",
      context: null,
    };

    const first = renderVariantCopy(v3b, slots, 0);
    const second = renderVariantCopy(v3b, slots, 1);

    expect(first.text).not.toBe(second.text);
    expect(first.text.replace(/\s+/g, " ")).toContain("Entry: 52¢");
    expect(second.text.replace(/\s+/g, " ")).toContain("Entry: 52¢");
  });
});

describe("credibility preference", () => {
  it("prefers avg_ev variants when avg_ev is available", () => {
    const inputs = baseInputs({
      entry: 52,
      now: undefined,
      postedCount30d: 0,
      avgStakeNotional: undefined,
      avg_ev: 0.12,
      winRate: 0.68,
    });
    const selection = selectPostTemplate(inputs, {
      lastTemplateFamily: "V7",
      random: () => 0,
    });
    expect(selection.templateFamily).toBe("V2");
    expect(
      selection.variantId === "V2-c" || selection.variantId === "V2-d"
    ).toBe(true);
  });

  it("uses win_rate path when avg_ev is missing", () => {
    const inputs = baseInputs({
      entry: 52,
      now: undefined,
      postedCount30d: 0,
      avgStakeNotional: undefined,
      avg_ev: undefined,
      winRate: 0.68,
    });
    const selection = selectPostTemplate(inputs, {
      lastTemplateFamily: "V7",
      random: () => 0,
    });
    expect(["V2-a", "V2-b"]).toContain(
      selection.variantId.replace(/^V2-/, "V2-")
    );
    expect(selection.variantId.startsWith("V2-")).toBe(true);
    expect(["V2-a", "V2-b"]).toContain(selection.variantId);
  });
});

describe("resolution receipt copy", () => {
  it("builds V8 draft with gain from entry cents", async () => {
    const { selectResolutionReceiptTemplate } = await import(
      "@/lib/templates/postTemplates"
    );
    const selection = selectResolutionReceiptTemplate(
      baseInputs({ gainCents: 36, entry: 64, now: 100 }),
      { random: () => 0 }
    );
    expect(selection.templateFamily).toBe("V8");
    expect(selection.renderedDraft).toMatch(/\+36¢/);
    expect(selection.renderedDraft).toMatch(/resolved YES/i);
  });
});
