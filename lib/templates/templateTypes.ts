import type { EvGloss } from "@/constants/evGlosses";

export const TEMPLATE_FAMILIES = [
  "V1",
  "V2",
  "V3",
  "V4",
  "V5",
  "V6",
  "V7",
  "V8",
] as const;

export type TemplateFamily = (typeof TEMPLATE_FAMILIES)[number];

export interface PostTemplateInputs {
  whale: string;
  side: string;
  /** Entry price in cents (e.g. 64 = 64¢). */
  entry: number;
  /** Live price in cents. */
  now?: number;
  /** Wallet avg EV decimal (0.12 = +12%). Preferred credibility stat. */
  avg_ev?: number;
  /** @deprecated Ignored — Templates.md does not include live trade EV in copy. */
  tradeEvPercent?: number | null;
  marketPlain?: string;
  stakeNotional: number;
  avgStakeNotional?: number;
  winRate?: number;
  resolvedBetsCount?: number;
  postedCount30d?: number;
  category?: string;
  /** Minutes from detection to post. */
  agoMinutes?: number;
  evGloss?: string;
  /** Optional one-sentence matchup background (OpenAI). */
  context?: string;
  /** Resolution receipt only (V8). */
  gainCents?: number;
  /** When true, fail closed before rendering (Templates.md anonymous rule). */
  anonymousWhale?: boolean;
  /** Template-layer resolved floor (defaults to 10). */
  minResolvedBets?: number;
}

export interface PostTemplateSelectionOptions {
  lastTemplateFamily?: string;
  lastVariantId?: string | null;
  /** Prior sentence-order index from the last queued post. */
  lastSentenceOrderIndex?: number | null;
  /** Prior EV gloss — excluded from rotation for this draft. */
  lastEvGloss?: string | null;
  /** When true, only V8 is eligible (resolved YES follow-up). */
  resolutionReceipt?: boolean;
  random?: () => number;
}

export interface PostTemplateSelection {
  templateFamily: TemplateFamily;
  variantId: string;
  renderedDraft: string;
  evGloss: EvGloss;
  sentenceOrderIndex: number;
  /** Optional OpenAI background — not part of Templates.md draft body. */
  marketContextMetadata?: string;
}
