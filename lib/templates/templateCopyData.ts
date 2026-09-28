import type { TemplateFamily } from "@/lib/templates/templateTypes";

/** Placeholders use `{name}` — filled by the render layer from slot context. */
export type TemplatePlaceholder =
  | "whale"
  | "stake"
  | "side"
  | "entry"
  | "winRate"
  | "resolved"
  | "avgEv"
  | "evGloss"
  | "evGlossThey"
  | "evGlossProgressive"
  | "now"
  | "ago"
  | "category"
  | "postedCount"
  | "repeatOrdinal"
  | "avgStake"
  | "gain";

export type CredibilityMode = "avg_ev" | "win_rate" | "any";

export interface TemplateVariantCopy {
  id: string;
  sentences: string[];
  required: TemplatePlaceholder[];
  credibility?: CredibilityMode;
}

export interface TemplateFamilyCopy {
  family: TemplateFamily;
  variants: TemplateVariantCopy[];
}

const PLACEHOLDER_SET = new Set<string>([
  "whale",
  "stake",
  "side",
  "entry",
  "winRate",
  "resolved",
  "avgEv",
  "evGloss",
  "evGlossThey",
  "evGlossProgressive",
  "now",
  "ago",
  "category",
  "postedCount",
  "repeatOrdinal",
  "avgStake",
  "gain",
]);

const PLACEHOLDER_IN_TEXT = /\{(\w+)\}/g;

function sentencesOnlyUseKnownPlaceholders(sentences: string[]): boolean {
  for (const sentence of sentences) {
    const matches = sentence.matchAll(PLACEHOLDER_IN_TEXT);
    for (const match of matches) {
      if (!PLACEHOLDER_SET.has(match[1])) return false;
    }
  }
  return true;
}

export function validateTemplateVariantCopy(
  variant: TemplateVariantCopy
): boolean {
  if (!variant.id?.trim()) return false;
  if (!Array.isArray(variant.sentences) || variant.sentences.length === 0) {
    return false;
  }
  if (!variant.sentences.every((s) => typeof s === "string" && s.trim())) {
    return false;
  }
  if (!Array.isArray(variant.required) || variant.required.length === 0) {
    return false;
  }
  if (!variant.required.every((p) => PLACEHOLDER_SET.has(p))) return false;
  if (!sentencesOnlyUseKnownPlaceholders(variant.sentences)) return false;
  if (
    variant.credibility &&
    variant.credibility !== "avg_ev" &&
    variant.credibility !== "win_rate" &&
    variant.credibility !== "any"
  ) {
    return false;
  }
  return true;
}

export function validateTemplateFamilyCopy(
  familyCopy: TemplateFamilyCopy
): boolean {
  if (!familyCopy.family?.trim()) return false;
  if (!Array.isArray(familyCopy.variants) || familyCopy.variants.length === 0) {
    return false;
  }
  return familyCopy.variants.every(validateTemplateVariantCopy);
}
