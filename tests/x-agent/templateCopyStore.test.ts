import { describe, expect, it } from "vitest";
import {
  buildTemplateCopyMap,
  clearTemplateCopyCacheForTests,
  getTemplateFamilyCopy,
  setTemplateCopyCacheForTests,
} from "@/lib/templates/templateCopyStore";
import { TEMPLATE_FAMILY_COPY_DEFAULTS } from "@/lib/templates/templateCopyDefaults";
import { selectPostTemplate } from "@/lib/templates/postTemplates";

describe("templateCopyStore", () => {
  it("falls back to bundled defaults when cache is empty", () => {
    clearTemplateCopyCacheForTests();
    const v1 = getTemplateFamilyCopy("V1");
    expect(v1.variants.length).toBeGreaterThan(0);
    expect(buildTemplateCopyMap(TEMPLATE_FAMILY_COPY_DEFAULTS)).not.toBeNull();
  });

  it("rejects incomplete runtime pools (requires all V1–V8 families)", () => {
    expect(
      buildTemplateCopyMap([
        {
          family: "V1",
          variants: [
            {
              id: "a",
              required: ["whale", "stake", "side", "entry", "winRate", "resolved"],
              sentences: [
                "{whale} put {stake} on {side} at {entry} ({winRate} / {resolved}).",
              ],
            },
          ],
        },
      ])
    ).toBeNull();
  });
});

describe("template draft body purity", () => {
  it("never includes undocumented context in renderedDraft across families", () => {
    clearTemplateCopyCacheForTests();
    const secret = "UNAPPROVED_OPENAI_CONTEXT_SNIPPET_XYZ";
    const inputs = {
      whale: "DeepWallet",
      side: "Zhizhen Zhang",
      entry: 35,
      now: 42,
      avg_ev: 0.12,
      marketPlain: "Champions League",
      stakeNotional: 52_000,
      avgStakeNotional: 20_000,
      postedCount30d: 2,
      resolvedBetsCount: 1_240,
      winRate: 0.68,
      category: "Champions League",
      context: secret,
    };

    for (let i = 0; i < 24; i += 1) {
      const selection = selectPostTemplate(inputs, {
        lastTemplateFamily: i % 2 === 0 ? "V1" : "V2",
        random: () => i / 24,
      });
      expect(selection.renderedDraft).not.toContain(secret);
    }
  });
});
