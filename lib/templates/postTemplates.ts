import { formatEvGloss } from "@/lib/x-agent/math";

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
  /** Wallet avg EV decimal (0.12 = +12%). */
  avg_ev: number;
  marketPlain: string;
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
}

export interface PostTemplateSelectionOptions {
  lastTemplateFamily?: string;
  /** When true, only V8 is eligible (resolved YES follow-up). */
  resolutionReceipt?: boolean;
  random?: () => number;
}

export interface PostTemplateSelection {
  templateFamily: TemplateFamily;
  variantId: string;
  renderedDraft: string;
}

export class PostTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostTemplateError";
  }
}

const FAMILY_PRIORITY: TemplateFamily[] = [
  "V8",
  "V6",
  "V7",
  "V3",
  "V5",
  "V4",
  "V2",
  "V1",
];

const LIVE_FAMILY_PRIORITY: TemplateFamily[] = FAMILY_PRIORITY.filter(
  (family) => family !== "V8"
);

const RESOLUTION_FAMILY_PRIORITY: TemplateFamily[] = ["V8"];

const QUIET_LINE_MAX_DELTA_CENTS = 2;
const CONTRARIAN_ENTRY_MAX_CENTS = 40;
const ROTATING_HASHTAGS = ["#polymarket"] as const;

type VariantRenderer = (ctx: RenderContext) => string;

interface TemplateVariant {
  id: string;
  render: VariantRenderer;
  requiredSlots?: Array<keyof RenderContext>;
}

interface TemplateFamilyDefinition {
  family: TemplateFamily;
  variants: TemplateVariant[];
  isEligible: (data: PostTemplateInputs) => boolean;
}

interface RenderContext {
  whale: string;
  side: string;
  market: string;
  category: string;
  entry: string;
  now: string | null;
  stake: string;
  avgStake: string | null;
  avgEv: string;
  winRate: string | null;
  resolved: string | null;
  postedCount: string | null;
  evGloss: string;
  evGlossThey: string;
  ago: string;
  gain: string | null;
  hashtag: string;
  context: string | null;
}

function assertRequiredBaseSlots(data: PostTemplateInputs): void {
  const missing: string[] = [];
  if (!data.whale?.trim()) missing.push("whale");
  if (!data.side?.trim()) missing.push("side");
  if (!Number.isFinite(data.entry)) missing.push("entry");
  if (!Number.isFinite(data.avg_ev)) missing.push("avg_ev");
  if (!data.marketPlain?.trim()) missing.push("marketPlain");
  if (!Number.isFinite(data.stakeNotional)) missing.push("stakeNotional");
  if (missing.length > 0) {
    throw new PostTemplateError(
      `Missing required template slots: ${missing.join(", ")}`
    );
  }
}

function formatCents(cents: number): string {
  return `${Math.round(cents)}`;
}

function formatUsd(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}k`;
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

function formatAvgEvPct(avgEv: number): string {
  const pct = avgEv * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

function formatWinRate(winRate?: number): string | null {
  if (winRate == null || !Number.isFinite(winRate)) return null;
  return `${Math.round(winRate * 100)}`;
}

/** EV gloss phrasing for "they …" / "as they …" (plural verb forms). */
function evGlossForThey(gloss: string): string {
  return gloss
    .replace(/^gets\b/, "get")
    .replace(/^wins\b/, "win")
    .replace(/^makes\b/, "make");
}

function lineDeltaCents(data: PostTemplateInputs): number | null {
  if (data.now == null || !Number.isFinite(data.now)) return null;
  return Math.abs(data.now - data.entry);
}

function lineMoved(data: PostTemplateInputs): boolean {
  const delta = lineDeltaCents(data);
  return delta != null && delta > QUIET_LINE_MAX_DELTA_CENTS;
}

function lineQuiet(data: PostTemplateInputs): boolean {
  const delta = lineDeltaCents(data);
  return delta != null && delta <= QUIET_LINE_MAX_DELTA_CENTS;
}

function hasStakeHistory(data: PostTemplateInputs): boolean {
  return (
    data.avgStakeNotional != null &&
    Number.isFinite(data.avgStakeNotional) &&
    data.avgStakeNotional > 0
  );
}

function hasTrackRecord(data: PostTemplateInputs): boolean {
  return (
    data.resolvedBetsCount != null &&
    Number.isFinite(data.resolvedBetsCount) &&
    data.resolvedBetsCount > 0
  );
}

function buildRenderContext(
  data: PostTemplateInputs,
  random: () => number
): RenderContext {
  const hashtag =
    random() < 0.2
      ? ROTATING_HASHTAGS[Math.floor(random() * ROTATING_HASHTAGS.length)]
      : "";

  const evGloss = data.evGloss ?? formatEvGloss(data.avg_ev, random);

  return {
    whale: data.whale.trim(),
    side: data.side.trim(),
    market: data.marketPlain.trim(),
    category: (data.category ?? data.marketPlain).trim(),
    entry: formatCents(data.entry),
    now:
      data.now != null && Number.isFinite(data.now)
        ? formatCents(data.now)
        : null,
    stake: formatUsd(data.stakeNotional),
    avgStake: hasStakeHistory(data) ? formatUsd(data.avgStakeNotional!) : null,
    avgEv: formatAvgEvPct(data.avg_ev),
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
    ago:
      data.agoMinutes != null && Number.isFinite(data.agoMinutes)
        ? `${Math.max(1, Math.round(data.agoMinutes))} min`
        : "moments",
    gain:
      data.gainCents != null && Number.isFinite(data.gainCents)
        ? `+${Math.round(data.gainCents)}`
        : null,
    hashtag,
    context: data.context?.trim() ? data.context.trim() : null,
  };
}

function assertVariantSlots(
  variant: TemplateVariant,
  ctx: RenderContext,
  family: TemplateFamily
): void {
  if (!variant.requiredSlots?.length) return;
  const missing = variant.requiredSlots.filter((slot) => {
    const value = ctx[slot];
    return value == null || value === "";
  });
  if (missing.length > 0) {
    throw new PostTemplateError(
      `${family}/${variant.id} missing slots: ${missing.join(", ")}`
    );
  }
}

const TEMPLATE_FAMILIES_DEF: TemplateFamilyDefinition[] = [
  {
    family: "V1",
    isEligible: () => true,
    variants: [
      {
        id: "a",
        render: (ctx) =>
          `${ctx.whale} just put ${ctx.stake} on ${ctx.side} at ${ctx.entry}¢. Their record: ${ctx.winRate ?? "—"}% across ${ctx.resolved ?? "—"} resolved bets.`,
        requiredSlots: ["winRate", "resolved"],
      },
      {
        id: "b",
        render: (ctx) =>
          `New position: ${ctx.stake} on ${ctx.side}, entered at ${ctx.entry}¢. This wallet has won ${ctx.winRate ?? "—"}% of ${ctx.resolved ?? "—"} bets.`,
        requiredSlots: ["winRate", "resolved"],
      },
      {
        id: "c",
        render: (ctx) =>
          `${ctx.stake} on ${ctx.side} ${ctx.ago} ago. The wallet behind it wins ${ctx.winRate ?? "—"}% of the time.`,
        requiredSlots: ["winRate"],
      },
      {
        id: "d",
        render: (ctx) =>
          `${ctx.whale} just moved ${ctx.stake} to ${ctx.side} at ${ctx.entry}¢. This wallet runs ${ctx.avgEv} AVG EV over ${ctx.resolved ?? "—"} resolved bets.`,
        requiredSlots: ["resolved"],
      },
      {
        id: "e",
        render: (ctx) =>
          `${ctx.whale} just made a move: ${ctx.side} on ${ctx.market} at ${ctx.entry}¢. Avg EV: ${ctx.avgEv}.`,
      },
    ],
  },
  {
    family: "V2",
    isEligible: (data) => hasTrackRecord(data),
    variants: [
      {
        id: "a",
        render: (ctx) =>
          `A wallet with ${ctx.resolved} resolved bets and a ${ctx.winRate}% win rate just moved: ${ctx.stake} on ${ctx.side} at ${ctx.entry}¢`,
        requiredSlots: ["resolved", "winRate"],
      },
      {
        id: "b",
        render: (ctx) =>
          `${ctx.winRate}% over ${ctx.resolved} bets. That's the record behind the ${ctx.stake} that just landed on ${ctx.side}.`,
        requiredSlots: ["resolved", "winRate"],
      },
      {
        id: "c",
        render: (ctx) =>
          `This wallet averages ${ctx.avgEv} EV across ${ctx.resolved} bets. New position: ${ctx.stake} on ${ctx.side} at ${ctx.entry}¢.`,
        requiredSlots: ["resolved"],
      },
      {
        id: "d",
        render: (ctx) =>
          `Anyone can win 80% betting favorites. This whale runs ${ctx.avgEv} EV over ${ctx.resolved} bets as they ${ctx.evGlossThey}. Just in: ${ctx.stake} on ${ctx.side}.`,
        requiredSlots: ["resolved"],
      },
    ],
  },
  {
    family: "V3",
    isEligible: (data) => lineMoved(data),
    variants: [
      {
        id: "a",
        render: (ctx) =>
          `${ctx.whale} entered ${ctx.side} at ${ctx.entry}¢. It's already ${ctx.now}¢. The move started ${ctx.ago} ago.`,
        requiredSlots: ["now"],
      },
      {
        id: "b",
        render: (ctx) =>
          `Entry: ${ctx.entry}¢. Now: ${ctx.now}¢. ${ctx.whale} (${ctx.winRate ?? "—"}% win rate) got in ${ctx.ago} ago on ${ctx.side}.`,
        requiredSlots: ["now"],
      },
      {
        id: "c",
        render: (ctx) =>
          `${ctx.whale} entered ${ctx.side} at ${ctx.entry}¢ — it's ${ctx.now}¢ now. Their AVG EV is ${ctx.avgEv}: historically they ${ctx.evGlossThey}. That gap is the edge.`,
        requiredSlots: ["now"],
      },
    ],
  },
  {
    family: "V4",
    isEligible: (data) => hasStakeHistory(data),
    variants: [
      {
        id: "a",
        render: (ctx) =>
          `${ctx.stake} is ${ctx.whale}'s biggest position this month. It's on ${ctx.side} at ${ctx.entry}¢.`,
        requiredSlots: ["avgStake"],
      },
      {
        id: "b",
        render: (ctx) =>
          `${ctx.whale} usually bets ~${ctx.avgStake}. Today: ${ctx.stake} on ${ctx.side}.`,
        requiredSlots: ["avgStake"],
      },
      {
        id: "c",
        render: (ctx) =>
          `${ctx.stake} on ${ctx.side} — ${ctx.whale}'s biggest swing this month, from a wallet running ${ctx.avgEv} EV across ${ctx.resolved ?? "—"} bets.`,
        requiredSlots: ["avgStake"],
      },
    ],
  },
  {
    family: "V5",
    isEligible: (data) => data.entry < CONTRARIAN_ENTRY_MAX_CENTS,
    variants: [
      {
        id: "a",
        render: (ctx) =>
          `The market says ${ctx.now ?? ctx.entry}¢. ${ctx.whale} (${ctx.winRate ?? "—"}% over ${ctx.resolved ?? "—"} bets) just took the other side at ${ctx.entry}¢, which is ${ctx.stake} on ${ctx.side}.`,
      },
      {
        id: "b",
        render: (ctx) =>
          `The crowd has this at ${ctx.now ?? ctx.entry}¢. ${ctx.whale} took ${ctx.side} at ${ctx.entry}¢ with ${ctx.stake} and their ${ctx.avgEv} AVG EV over ${ctx.resolved ?? "—"} bets says they usually ${ctx.evGlossThey}.`,
      },
    ],
  },
  {
    family: "V6",
    isEligible: (data) => (data.postedCount30d ?? 0) >= 2,
    variants: [
      {
        id: "a",
        render: (ctx) =>
          `${ctx.whale} is back. Third ${ctx.category} position this week and this time ${ctx.stake} on ${ctx.side} at ${ctx.entry}¢.`,
        requiredSlots: ["postedCount"],
      },
      {
        id: "b",
        render: (ctx) =>
          `${ctx.whale} again. Third ${ctx.category} move this week: ${ctx.stake} on ${ctx.side} at ${ctx.entry}¢. Still running ${ctx.avgEv} EV over ${ctx.resolved ?? "—"} bets and still ${ctx.evGloss}.`,
        requiredSlots: ["postedCount"],
      },
    ],
  },
  {
    family: "V7",
    isEligible: (data) => lineQuiet(data),
    variants: [
      {
        id: "a",
        render: (ctx) =>
          `${ctx.stake} on ${ctx.side} at ${ctx.entry}¢ from a wallet that's won ${ctx.winRate ?? "—"}% of ${ctx.resolved ?? "—"} bets. Most people will never look.`,
        requiredSlots: ["now"],
      },
      {
        id: "b",
        render: (ctx) =>
          `Every position on Polymarket is public. This one is ${ctx.stake} on ${ctx.side} by a ${ctx.winRate ?? "—"}% wallet and the price hasn't moved. Still ${ctx.now}¢.`,
        requiredSlots: ["now"],
      },
      {
        id: "c",
        render: (ctx) =>
          `${ctx.stake} on ${ctx.side} at ${ctx.entry}¢ from a wallet averaging ${ctx.avgEv} EV across ${ctx.resolved ?? "—"} bets as they ${ctx.evGlossThey}. The market hasn't noticed yet.`,
        requiredSlots: ["now"],
      },
      {
        id: "d",
        render: (ctx) =>
          `${ctx.whale} put ${ctx.stake} on ${ctx.side} ${ctx.ago} ago. Price hasn't budged: still ${ctx.now}¢. A ${ctx.winRate ?? "—"}% wallet moved and nobody looked up.`,
        requiredSlots: ["now"],
      },
    ],
  },
  {
    family: "V8",
    isEligible: (data) =>
      data.gainCents != null && Number.isFinite(data.gainCents),
    variants: [
      {
        id: "a",
        render: (ctx) =>
          `Update: ${ctx.whale}'s ${ctx.stake} on ${ctx.side} (posted here at ${ctx.entry}¢) just resolved YES. Entry to resolution: ${ctx.gain}¢.`,
        requiredSlots: ["gain"],
      },
      {
        id: "b",
        render: (ctx) =>
          `Receipt: ${ctx.whale}'s ${ctx.stake} on ${ctx.side} resolved YES. Posted at ${ctx.entry}¢, paid out at 100¢. This is what ${ctx.avgEv} AVG EV looks like — profit per bet, not luck.`,
        requiredSlots: ["gain"],
      },
    ],
  },
];

const FAMILY_MAP = new Map(
  TEMPLATE_FAMILIES_DEF.map((definition) => [definition.family, definition])
);

export function getEligibleTemplateFamilies(
  data: PostTemplateInputs,
  options?: Pick<PostTemplateSelectionOptions, "resolutionReceipt">
): TemplateFamily[] {
  if (options?.resolutionReceipt) {
    return FAMILY_MAP.get("V8")?.isEligible(data) ? ["V8"] : [];
  }

  const eligible: TemplateFamily[] = [];
  for (const family of LIVE_FAMILY_PRIORITY) {
    const definition = FAMILY_MAP.get(family);
    if (definition?.isEligible(data)) eligible.push(family);
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

function pickVariant(
  family: TemplateFamily,
  ctx: RenderContext,
  random: () => number
): { variantId: string; rendered: string } {
  const definition = FAMILY_MAP.get(family);
  if (!definition) {
    throw new PostTemplateError(`Unknown template family: ${family}`);
  }

  const shuffled = [...definition.variants];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  for (const variant of shuffled) {
    try {
      assertVariantSlots(variant, ctx, family);
      const rendered = variant.render(ctx).trim();
      if (!rendered) continue;
      return { variantId: `${family}-${variant.id}`, rendered };
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
  assertRequiredBaseSlots(data);

  const family = pickFamily(
    data,
    options.lastTemplateFamily,
    random,
    options.resolutionReceipt
  );
  const ctx = buildRenderContext(data, random);
  const { variantId, rendered } = pickVariant(family, ctx, random);

  let renderedDraft = sanitizePostDraft(rendered);
  if (ctx.context) {
    renderedDraft = sanitizePostDraft(`${renderedDraft} ${ctx.context}`);
  }
  if (ctx.hashtag && !renderedDraft.toLowerCase().includes(ctx.hashtag.toLowerCase())) {
    renderedDraft = sanitizePostDraft(`${renderedDraft} ${ctx.hashtag}`);
  }

  if (!renderedDraft) {
    throw new PostTemplateError("Template rendered empty copy after sanitization");
  }

  return {
    templateFamily: family,
    variantId,
    renderedDraft,
  };
}

/** Alias for pipeline integrations and test scripts. */
export function selectAndRenderPostTemplate(
  data: PostTemplateInputs,
  options: PostTemplateSelectionOptions = {}
): PostTemplateSelection {
  return selectPostTemplate(data, options);
}

/** Resolution follow-up posts (V8 only). */
export function selectResolutionReceiptTemplate(
  data: PostTemplateInputs,
  options: Omit<PostTemplateSelectionOptions, "resolutionReceipt"> = {}
): PostTemplateSelection {
  return selectPostTemplate(data, { ...options, resolutionReceipt: true });
}
