import {
  evGlossForThey,
  formatAvgEvPercent,
  isEvGloss,
  progressiveEvGloss,
  selectEvGloss,
  type EvGloss,
} from "@/constants/evGlosses";
import { sanitizeTemplateSide } from "@/lib/x-agent/sideSanitizer";
import type {
  CredibilityMode,
  TemplatePlaceholder,
  TemplateVariantCopy,
} from "@/lib/templates/templateCopyData";
import type { PostTemplateInputs } from "@/lib/templates/templateTypes";

export class PostTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostTemplateError";
  }
}

const RAW_WALLET_RE = /^0x[a-fA-F0-9]{8,}$/;

export interface SlotValues {
  whale: string;
  side: string;
  entry: string;
  stake: string;
  avgEv: string | null;
  winRate: string | null;
  resolved: string | null;
  postedCount: string | null;
  avgStake: string | null;
  now: string | null;
  ago: string;
  gain: string | null;
  category: string | null;
  evGloss: string;
  evGlossThey: string;
  evGlossProgressive: string;
  repeatOrdinal: string | null;
  hashtag: string;
  context: string | null;
}

const ORDINAL_WORDS: Record<number, string> = {
  3: "Third",
  4: "Fourth",
  5: "Fifth",
  6: "Sixth",
  7: "Seventh",
  8: "Eighth",
  9: "Ninth",
  10: "Tenth",
};

/** Repeat-character ordinal for this post (prior posts + 1). */
export function repeatCharacterOrdinal(postedCount30d: number): string | null {
  if (!Number.isFinite(postedCount30d) || postedCount30d < 2) return null;
  const n = postedCount30d + 1;
  return ORDINAL_WORDS[n] ?? `${n}th`;
}

/** Stake exceeds wallet rolling average — supports V4 conviction copy. */
export function hasConvictionRelativeStake(data: PostTemplateInputs): boolean {
  return (
    hasStakeHistory(data) &&
    Number.isFinite(data.stakeNotional) &&
    data.stakeNotional > data.avgStakeNotional!
  );
}

export function formatCents(cents: number): string {
  return `${Math.round(cents)}¢`;
}

export function formatUsd(amount: number, opts?: { approx?: boolean }): string {
  const prefix = opts?.approx ? "~$" : "$";
  if (amount >= 1_000_000) {
    const value = amount / 1_000_000;
    const formatted = Number.isInteger(value)
      ? String(value)
      : value.toFixed(1).replace(/\.0$/, "");
    return `${prefix}${formatted}M`;
  }
  if (amount >= 1_000) {
    return `${prefix}${Math.round(amount / 1_000)}K`;
  }
  return `${prefix}${Math.round(amount).toLocaleString("en-US")}`;
}

function formatWinRate(winRate?: number): string | null {
  if (winRate == null || !Number.isFinite(winRate)) return null;
  return `${Math.round(winRate * 100)}%`;
}

export function resolvedBetCount(data: PostTemplateInputs): number {
  return data.resolvedBetsCount != null && Number.isFinite(data.resolvedBetsCount)
    ? data.resolvedBetsCount
    : 0;
}

export function hasCredibleTrackRecord(
  data: PostTemplateInputs,
  minResolved: number
): boolean {
  return resolvedBetCount(data) >= minResolved;
}

export function hasAvgEv(data: PostTemplateInputs, minResolved: number): boolean {
  return (
    hasCredibleTrackRecord(data, minResolved) &&
    data.avg_ev != null &&
    Number.isFinite(data.avg_ev)
  );
}

export function hasWinRateCredibility(
  data: PostTemplateInputs,
  minResolved: number
): boolean {
  return (
    hasCredibleTrackRecord(data, minResolved) &&
    data.winRate != null &&
    Number.isFinite(data.winRate)
  );
}

export function hasStakeHistory(data: PostTemplateInputs): boolean {
  return (
    data.avgStakeNotional != null &&
    Number.isFinite(data.avgStakeNotional) &&
    data.avgStakeNotional > 0
  );
}

export function assertRequiredBaseSlots(
  data: PostTemplateInputs,
  minResolved: number
): void {
  if (data.anonymousWhale) {
    throw new PostTemplateError("Anonymous wallet — no draft");
  }

  const missing: string[] = [];
  if (!data.whale?.trim()) missing.push("whale");
  else if (RAW_WALLET_RE.test(data.whale.trim())) missing.push("whale(named)");

  const side = sanitizeTemplateSide(data.side);
  if (!side) missing.push("side(named)");

  if (!Number.isFinite(data.entry)) missing.push("entry");
  if (!Number.isFinite(data.stakeNotional)) missing.push("stakeNotional");

  if (!hasCredibleTrackRecord(data, minResolved)) {
    missing.push(`resolved(>=${minResolved})`);
  } else if (hasAvgEv(data, minResolved)) {
    // avg_ev preferred — satisfied
  } else if (hasWinRateCredibility(data, minResolved)) {
    // win_rate + resolved — satisfied
  } else {
    missing.push("credibility(avg_ev|win_rate+resolved)");
  }

  if (missing.length > 0) {
    throw new PostTemplateError(
      `Missing required template slots: ${missing.join(", ")}`
    );
  }
}

export function buildSlotValues(
  data: PostTemplateInputs,
  random: () => number,
  lastEvGloss?: string | null
): { slots: SlotValues; evGloss: EvGloss } {
  const hashtag =
    random() < 0.2
      ? "#polymarket"
      : "";

  const evGloss: EvGloss = isEvGloss(data.evGloss)
    ? data.evGloss
    : selectEvGloss({ excludeGloss: lastEvGloss, random });

  const minResolved = data.minResolvedBets ?? 10;
  const avgEv = hasAvgEv(data, minResolved)
    ? formatAvgEvPercent(data.avg_ev!)
    : null;

  const category =
    data.category?.trim() || data.marketPlain?.trim() || null;

  const slots: SlotValues = {
    whale: data.whale.trim(),
    side: sanitizeTemplateSide(data.side) ?? data.side.trim(),
    entry: formatCents(data.entry),
    now:
      data.now != null && Number.isFinite(data.now)
        ? formatCents(data.now)
        : null,
    stake: formatUsd(data.stakeNotional),
    avgStake: hasStakeHistory(data)
      ? formatUsd(data.avgStakeNotional!, { approx: true })
      : null,
    avgEv,
    winRate: formatWinRate(data.winRate),
    resolved:
      data.resolvedBetsCount != null && Number.isFinite(data.resolvedBetsCount)
        ? data.resolvedBetsCount.toLocaleString("en-US")
        : null,
    postedCount:
      data.postedCount30d != null && Number.isFinite(data.postedCount30d)
        ? String(data.postedCount30d)
        : null,
    evGloss,
    evGlossThey: evGlossForThey(evGloss),
    evGlossProgressive: progressiveEvGloss(evGloss),
    repeatOrdinal:
      data.postedCount30d != null
        ? repeatCharacterOrdinal(data.postedCount30d)
        : null,
    ago:
      data.agoMinutes != null && Number.isFinite(data.agoMinutes)
        ? `${Math.max(1, Math.round(data.agoMinutes))} min`
        : "moments",
    gain:
      data.gainCents != null && Number.isFinite(data.gainCents)
        ? `+${Math.round(data.gainCents)}¢`
        : null,
    hashtag,
    category,
    context: data.context?.trim() ? data.context.trim() : null,
  };

  return { slots, evGloss };
}

function slotValue(slots: SlotValues, key: TemplatePlaceholder): string | null {
  switch (key) {
    case "whale":
      return slots.whale;
    case "stake":
      return slots.stake;
    case "side":
      return slots.side;
    case "entry":
      return slots.entry;
    case "winRate":
      return slots.winRate;
    case "resolved":
      return slots.resolved;
    case "avgEv":
      return slots.avgEv;
    case "evGloss":
      return slots.evGloss;
    case "evGlossThey":
      return slots.evGlossThey;
    case "evGlossProgressive":
      return slots.evGlossProgressive;
    case "now":
      return slots.now;
    case "ago":
      return slots.ago;
    case "category":
      return slots.category;
    case "postedCount":
      return slots.postedCount;
    case "avgStake":
      return slots.avgStake;
    case "repeatOrdinal":
      return slots.repeatOrdinal;
    case "gain":
      return slots.gain;
    default:
      return null;
  }
}

export function assertVariantSlots(
  variant: TemplateVariantCopy,
  slots: SlotValues
): void {
  const missing = variant.required.filter((key) => {
    const value = slotValue(slots, key);
    return value == null || value === "";
  });
  if (missing.length > 0) {
    throw new PostTemplateError(
      `missing slots: ${missing.join(", ")}`
    );
  }
}

export function fillPlaceholderString(
  template: string,
  slots: SlotValues
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = slotValue(slots, key as TemplatePlaceholder);
    if (value == null || value === "") {
      throw new PostTemplateError(`unfilled placeholder {${key}}`);
    }
    return value;
  });
}

/** Rotate sentence order: orderIndex selects which sentence leads. */
export function renderVariantCopy(
  variant: TemplateVariantCopy,
  slots: SlotValues,
  sentenceOrderIndex: number
): { text: string; sentenceOrderIndex: number } {
  const n = variant.sentences.length;
  const start = n > 0 ? sentenceOrderIndex % n : 0;
  const ordered =
    n <= 1
      ? variant.sentences
      : [...variant.sentences.slice(start), ...variant.sentences.slice(0, start)];

  const parts = ordered.map((sentence) => fillPlaceholderString(sentence, slots));
  return { text: parts.join(" ").trim(), sentenceOrderIndex: start };
}

export function variantMeetsCredibility(
  variant: TemplateVariantCopy,
  data: PostTemplateInputs,
  minResolved: number
): boolean {
  const mode = variant.credibility ?? "any";
  if (mode === "avg_ev") return hasAvgEv(data, minResolved);
  if (mode === "win_rate") return hasWinRateCredibility(data, minResolved);
  return true;
}

export function compareVariantCredibilityPreference(
  a: TemplateVariantCopy,
  b: TemplateVariantCopy,
  preferAvgEv: boolean
): number {
  const score = (v: TemplateVariantCopy) => {
    if (v.credibility === "avg_ev") return preferAvgEv ? 0 : 2;
    if (v.credibility === "win_rate") return preferAvgEv ? 2 : 0;
    return 1;
  };
  return score(a) - score(b);
}
