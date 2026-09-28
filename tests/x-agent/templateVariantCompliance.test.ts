import { describe, expect, it } from "vitest";
import { EV_GLOSSES } from "@/constants/evGlosses";
import { TEMPLATE_FAMILY_COPY_DEFAULTS } from "@/lib/templates/templateCopyDefaults";
import { sanitizePostDraft } from "@/lib/templates/postTemplates";
import {
  buildSlotValues,
  renderVariantCopy,
} from "@/lib/templates/templateRender";
import type { PostTemplateInputs } from "@/lib/templates/templateTypes";
import type { TemplateVariantCopy } from "@/lib/templates/templateCopyData";

const WHALE = "CrimsonVanguard";
const SIDE = "Zhizhen Zhang";

const UNSUPPORTED_PATTERNS = [
  /biggest position this month/i,
  /biggest swing this month/i,
  /position this week/i,
  /move this week/i,
];

function baseInputs(overrides: Partial<PostTemplateInputs> = {}): PostTemplateInputs {
  return {
    whale: WHALE,
    side: SIDE,
    entry: 64,
    now: 65,
    avg_ev: 0.12,
    marketPlain: "Champions League",
    category: "Champions League",
    stakeNotional: 52_000,
    avgStakeNotional: 8_000,
    postedCount30d: 2,
    resolvedBetsCount: 1_240,
    winRate: 0.68,
    agoMinutes: 8,
    gainCents: 36,
    ...overrides,
  };
}

function renderFinal(
  variant: TemplateVariantCopy,
  inputs: PostTemplateInputs
): string {
  const { slots } = buildSlotValues(inputs, () => 0.5, null);
  const { text } = renderVariantCopy(variant, slots, 0);
  let out = sanitizePostDraft(text);
  if (
    slots.hashtag &&
    !out.toLowerCase().includes(slots.hashtag.toLowerCase())
  ) {
    out = sanitizePostDraft(`${out} ${slots.hashtag}`);
  }
  return out;
}

function hasAvgEvWithGloss(text: string, avgEvLabel: string): boolean {
  if (!text.includes(avgEvLabel)) return false;
  const fixedGlossPhrases = [
    "win at the right price",
    "getting in at the right price",
    "get in at better prices than the market",
    "getting in at better prices than the market",
    "better entry prices",
    "get paid for disagreeing with the crowd",
    "profit per bet, not luck",
  ];
  if (fixedGlossPhrases.some((p) => text.includes(p))) return true;
  return EV_GLOSSES.some((g) => text.includes(g));
}

function hasWinRateAndResolved(
  text: string,
  winRate: string,
  resolved: string
): boolean {
  return text.includes(winRate) && text.includes(resolved);
}

describe("all 24 template variants — rendered compliance", () => {
  const cases: Array<{ id: string; variant: TemplateVariantCopy }> = [];
  for (const family of TEMPLATE_FAMILY_COPY_DEFAULTS) {
    for (const variant of family.variants) {
      cases.push({ id: `${family.family}-${variant.id}`, variant });
    }
  }

  expect(cases.length).toBe(24);

  for (const { id, variant } of cases) {
    it(`${id} meets visible-slot and safety rules`, () => {
      const inputs = baseInputs();
      const { slots } = buildSlotValues(inputs, () => 0.5, null);
      const draft = renderFinal(variant, inputs);

      expect(draft).toContain(WHALE);
      expect(draft).toContain(SIDE);
      expect(draft).toContain(slots.entry);
      expect(draft).not.toMatch(/\{[a-zA-Z]+\}/);
      expect(draft).not.toMatch(/https?:\/\//i);
      expect(draft).not.toContain("🚨");

      for (const pattern of UNSUPPORTED_PATTERNS) {
        expect(draft).not.toMatch(pattern);
      }

      const avgOk =
        slots.avgEv != null && hasAvgEvWithGloss(draft, slots.avgEv);
      const winOk =
        slots.winRate != null &&
        slots.resolved != null &&
        hasWinRateAndResolved(draft, slots.winRate, slots.resolved);

      if (variant.credibility === "avg_ev") {
        expect(avgOk, `${id} missing avg_ev + gloss in: ${draft}`).toBe(true);
      } else if (variant.credibility === "win_rate") {
        expect(winOk, `${id} missing win_rate + resolved in: ${draft}`).toBe(
          true
        );
      } else {
        expect(avgOk || winOk, `${id} missing credibility in: ${draft}`).toBe(
          true
        );
      }
    });
  }
});
