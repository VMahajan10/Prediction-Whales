import {
  evGlossForThey,
  progressiveEvGloss,
  type EvGloss,
} from "@/constants/evGlosses";
import type { TemplateFamilyCopy } from "@/lib/templates/templateCopyData";
import { getTemplateFamilyCopy } from "@/lib/templates/templateCopyStore";
import {
  MIN_TEMPLATE_RESOLVED_BETS,
} from "@/lib/templates/templatesDoc";
import {
  assertRequiredBaseSlots,
  assertVariantSlots,
  buildSlotValues,
  compareVariantCredibilityPreference,
  hasAvgEv,
  hasConvictionRelativeStake,
  hasStakeHistory,
  hasWinRateCredibility,
  PostTemplateError,
  renderVariantCopy,
  repeatCharacterOrdinal,
  resolvedBetCount,
  variantMeetsCredibility,
} from "@/lib/templates/templateRender";
import {
  TEMPLATE_FAMILIES,
  type PostTemplateInputs,
  type PostTemplateSelection,
  type PostTemplateSelectionOptions,
  type TemplateFamily,
} from "@/lib/templates/templateTypes";

export {
  TEMPLATE_FAMILIES,
  type TemplateFamily,
  type PostTemplateInputs,
  type PostTemplateSelection,
  type PostTemplateSelectionOptions,
};
export { PostTemplateError };

/** Live priority: V5 → V7 → V3 → V4 → V6 → V2 → V1 (V8 is receipt-only). */
const LIVE_FAMILY_PRIORITY: TemplateFamily[] = [
  "V5",
  "V7",
  "V3",
  "V4",
  "V6",
  "V2",
  "V1",
];

const RESOLUTION_FAMILY_PRIORITY: TemplateFamily[] = ["V8"];

const QUIET_LINE_MAX_DELTA_CENTS = 2;
const CONTRARIAN_ENTRY_MAX_CENTS = 40;
/** Whales already posted ≥2× (Templates.md V6). */
const REPEAT_CHARACTER_MIN_POSTS = 2;

function minResolved(data: PostTemplateInputs): number {
  return data.minResolvedBets ?? MIN_TEMPLATE_RESOLVED_BETS;
}

export { MIN_TEMPLATE_RESOLVED_BETS, TEMPLATES_MD_GATE_RESOLVED_BETS_FLOOR } from "@/lib/templates/templatesDoc";

function lineDeltaCents(data: PostTemplateInputs): number | null {
  if (data.now == null || !Number.isFinite(data.now)) return null;
  return Math.abs(data.now - data.entry);
}

function lineMoved(data: PostTemplateInputs): boolean {
  const delta = lineDeltaCents(data);
  return delta != null && data.now !== data.entry;
}

function lineQuiet(data: PostTemplateInputs): boolean {
  const delta = lineDeltaCents(data);
  return delta != null && delta <= QUIET_LINE_MAX_DELTA_CENTS;
}

function hasTrackRecordSlots(data: PostTemplateInputs): boolean {
  const floor = minResolved(data);
  return (
    resolvedBetCount(data) >= floor &&
    (hasAvgEv(data, floor) || hasWinRateCredibility(data, floor))
  );
}

type FamilyEligibility = (data: PostTemplateInputs) => boolean;

const FAMILY_ELIGIBILITY: Record<TemplateFamily, FamilyEligibility> = {
  V1: () => true,
  V2: (data) => hasTrackRecordSlots(data),
  V3: (data) => lineMoved(data),
  V4: (data) => hasStakeHistory(data),
  V5: (data) => data.entry < CONTRARIAN_ENTRY_MAX_CENTS,
  V6: (data) =>
    (data.postedCount30d ?? 0) >= REPEAT_CHARACTER_MIN_POSTS &&
    Boolean(data.category?.trim() || data.marketPlain?.trim()),
  V7: (data) => lineQuiet(data),
  V8: (data) =>
    data.gainCents != null && Number.isFinite(data.gainCents),
};

export function getEligibleTemplateFamilies(
  data: PostTemplateInputs,
  options?: Pick<PostTemplateSelectionOptions, "resolutionReceipt">
): TemplateFamily[] {
  if (options?.resolutionReceipt) {
    return FAMILY_ELIGIBILITY.V8(data) ? ["V8"] : [];
  }

  const eligible: TemplateFamily[] = [];
  for (const family of LIVE_FAMILY_PRIORITY) {
    if (FAMILY_ELIGIBILITY[family](data)) eligible.push(family);
  }
  return eligible.length > 0 ? eligible : ["V1"];
}

function pickFamily(
  data: PostTemplateInputs,
  lastTemplateFamily: string | undefined,
  random: () => number,
  resolutionReceipt?: boolean
): TemplateFamily {
  const eligible = getEligibleTemplateFamilies(data, { resolutionReceipt });
  const withoutRepeat = eligible.filter(
    (family) => family !== lastTemplateFamily
  );
  const candidates = withoutRepeat.length > 0 ? withoutRepeat : eligible;

  const priority: TemplateFamily[] = resolutionReceipt
    ? RESOLUTION_FAMILY_PRIORITY
    : LIVE_FAMILY_PRIORITY;
  const weighted = priority.filter((family) => candidates.includes(family));
  if (weighted.length > 0) {
    return weighted[0];
  }

  const index = Math.floor(random() * candidates.length);
  return candidates[index] ?? "V1";
}

function variantMeetsFamilySlotRules(
  family: TemplateFamily,
  variant: TemplateFamilyCopy["variants"][number],
  data: PostTemplateInputs
): boolean {
  if (family === "V4" && (variant.id === "a" || variant.id === "c")) {
    return hasConvictionRelativeStake(data);
  }
  if (family === "V6" && (variant.id === "a" || variant.id === "b")) {
    return repeatCharacterOrdinal(data.postedCount30d ?? 0) != null;
  }
  return true;
}

function pickVariant(
  family: TemplateFamily,
  familyCopy: TemplateFamilyCopy,
  data: PostTemplateInputs,
  slots: ReturnType<typeof buildSlotValues>["slots"],
  options: {
    lastVariantId?: string | null;
    lastSentenceOrderIndex?: number | null;
    random: () => number;
  }
): { variantId: string; rendered: string; sentenceOrderIndex: number } {
  const floor = minResolved(data);
  const preferAvgEv = hasAvgEv(data, floor);

  let variants = familyCopy.variants.filter((variant) =>
    variantMeetsCredibility(variant, data, floor)
  );

  variants = variants.filter((variant) =>
    variantMeetsFamilySlotRules(family, variant, data)
  );

  variants.sort((a, b) =>
    compareVariantCredibilityPreference(a, b, preferAvgEv)
  );

  const withoutRepeat = variants.filter(
    (v) => `${family}-${v.id}` !== options.lastVariantId
  );
  if (withoutRepeat.length > 0) {
    variants = withoutRepeat;
  }

  const shuffled = [...variants];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(options.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const baseOrder =
    options.lastSentenceOrderIndex != null &&
    Number.isFinite(options.lastSentenceOrderIndex)
      ? options.lastSentenceOrderIndex + 1
      : 0;

  for (const variant of shuffled) {
    try {
      assertVariantSlots(variant, slots);
      const { text, sentenceOrderIndex } = renderVariantCopy(
        variant,
        slots,
        baseOrder
      );
      if (!text) continue;
      return {
        variantId: `${family}-${variant.id}`,
        rendered: text,
        sentenceOrderIndex,
      };
    } catch {
      continue;
    }
  }

  throw new PostTemplateError(
    `No renderable variant for template family ${family}`
  );
}

/** Strip URLs, siren emojis, forbidden hashtags, and trailing hashtag blocks. */
export function sanitizePostDraft(text: string): string {
  let out = text.replace(/https?:\/\/\S+/gi, "");
  out = out.replace(/🚨/g, "");
  out = out.replace(/#crypto\b/gi, "");

  const hashtags = out.match(/#\w+/gi) ?? [];
  if (hashtags.length > 1) {
    let kept = 0;
    out = out.replace(/#\w+/gi, (tag) => {
      kept += 1;
      return kept === 1 ? tag : "";
    });
  }

  return out.replace(/\s{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
}

export function selectPostTemplate(
  data: PostTemplateInputs,
  options: PostTemplateSelectionOptions = {}
): PostTemplateSelection {
  const random = options.random ?? Math.random;
  assertRequiredBaseSlots(data, minResolved(data));

  const family = pickFamily(
    data,
    options.lastTemplateFamily,
    random,
    options.resolutionReceipt
  );

  const familyCopy = getTemplateFamilyCopy(family);

  const { slots, evGloss } = buildSlotValues(data, random, options.lastEvGloss);

  const { variantId, rendered, sentenceOrderIndex } = pickVariant(
    family,
    familyCopy,
    data,
    slots,
    {
      lastVariantId: options.lastVariantId,
      lastSentenceOrderIndex: options.lastSentenceOrderIndex,
      random,
    }
  );

  let renderedDraft = sanitizePostDraft(rendered);
  if (
    slots.hashtag &&
    !renderedDraft.toLowerCase().includes(slots.hashtag.toLowerCase())
  ) {
    renderedDraft = sanitizePostDraft(`${renderedDraft} ${slots.hashtag}`);
  }

  if (!renderedDraft) {
    throw new PostTemplateError(
      "Template rendered empty copy after sanitization"
    );
  }

  if (
    slots.avgEv &&
    renderedDraft.includes(slots.avgEv) &&
    !renderedDraft.includes("AVG EV") &&
    !renderedDraft.includes(evGloss) &&
    !renderedDraft.includes(evGlossForThey(evGloss)) &&
    !renderedDraft.includes(progressiveEvGloss(evGloss))
  ) {
    renderedDraft = sanitizePostDraft(`${renderedDraft} (${evGloss})`);
  }

  return {
    templateFamily: family,
    variantId,
    renderedDraft,
    evGloss,
    sentenceOrderIndex,
    marketContextMetadata: data.context?.trim() || undefined,
  };
}

export function selectAndRenderPostTemplate(
  data: PostTemplateInputs,
  options: PostTemplateSelectionOptions = {}
): PostTemplateSelection {
  return selectPostTemplate(data, options);
}

export function selectResolutionReceiptTemplate(
  data: PostTemplateInputs,
  options: Omit<PostTemplateSelectionOptions, "resolutionReceipt"> = {}
): PostTemplateSelection {
  return selectPostTemplate(data, { ...options, resolutionReceipt: true });
}

/** Exported for tests — V5 contrarian entry ceiling in cents. */
export const CONTRARIAN_MAX_ENTRY_CENTS = CONTRARIAN_ENTRY_MAX_CENTS;
export const REPEAT_CHARACTER_MIN_POSTED_COUNT = REPEAT_CHARACTER_MIN_POSTS;
