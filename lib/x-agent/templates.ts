import { formatEvGloss } from "@/lib/x-agent/math";

export const TEMPLATE_FAMILIES = [
  "V1",
  "V2",
  "V3",
  "V4",
  "V5",
  "V6",
  "V7",
] as const;

export type TemplateFamily = (typeof TEMPLATE_FAMILIES)[number];

export interface TemplateSchemaInputs {
  /** Whale pseudonym — required slot {whale}. */
  whale: string;
  /** Plain-language side, e.g. "buy yes" — required slot {side}. */
  side: string;
  /** Entry price in cents — required slot {entry}. */
  entry: number;
  /** Raw average EV decimal, e.g. 0.12 — required slot {avg_ev}. */
  avg_ev: number;
  marketPlain: string;
  stakeNotional: number;
  /** Current line in cents (for V3 / V7). */
  now?: number;
  /** Optional EV gloss; generated when omitted. */
  evGloss?: string;
  winRate?: number;
  resolvedBetsCount?: number;
  postedCount30d?: number;
  avgStakeNotional?: number;
  /** When true, enables V4 (Conviction). */
  hasStakeHistory?: boolean;
}

export class TemplateGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateGenerationError";
  }
}

const FAMILY_PRIORITY: TemplateFamily[] = [
  "V6",
  "V7",
  "V3",
  "V5",
  "V4",
  "V2",
  "V1",
];

const LINE_MOVE_EPSILON_CENTS = 0.01;

function assertRequiredSlots(data: TemplateSchemaInputs): void {
  const missing: string[] = [];

  if (data.whale == null || String(data.whale).trim() === "") {
    missing.push("whale");
  }
  if (data.side == null || String(data.side).trim() === "") {
    missing.push("side");
  }
  if (data.entry == null || !Number.isFinite(data.entry)) {
    missing.push("entry");
  }
  if (data.avg_ev == null || !Number.isFinite(data.avg_ev)) {
    missing.push("avg_ev");
  }

  if (missing.length > 0) {
    throw new TemplateGenerationError(
      `Missing required template slots: ${missing.join(", ")}`
    );
  }
}

function lineMoved(data: TemplateSchemaInputs): boolean {
  if (data.now == null || !Number.isFinite(data.now)) return false;
  return Math.abs(data.now - data.entry) > LINE_MOVE_EPSILON_CENTS;
}

function lineUnchanged(data: TemplateSchemaInputs): boolean {
  if (data.now == null || !Number.isFinite(data.now)) return false;
  return Math.abs(data.now - data.entry) <= LINE_MOVE_EPSILON_CENTS;
}

function hasStakeHistory(data: TemplateSchemaInputs): boolean {
  if (data.hasStakeHistory === true) return true;
  return (
    data.avgStakeNotional != null &&
    Number.isFinite(data.avgStakeNotional) &&
    data.avgStakeNotional > 0
  );
}

function eligibleFamilies(data: TemplateSchemaInputs): TemplateFamily[] {
  const families: TemplateFamily[] = ["V1", "V2"];

  if (lineMoved(data)) families.push("V3");
  if (hasStakeHistory(data)) families.push("V4");
  if (data.entry < 40) families.push("V5");
  if ((data.postedCount30d ?? 0) >= 2) families.push("V6");
  if (lineUnchanged(data)) families.push("V7");

  return families;
}

function pickFamily(
  data: TemplateSchemaInputs,
  lastFamilyUsed?: string
): TemplateFamily {
  const eligible = eligibleFamilies(data);
  const candidates = eligible.filter((family) => family !== lastFamilyUsed);

  if (candidates.length === 0) {
    throw new TemplateGenerationError(
      `No template family available after excluding last used family (${lastFamilyUsed})`
    );
  }

  for (const family of FAMILY_PRIORITY) {
    if (candidates.includes(family)) return family;
  }

  return candidates[0];
}

function formatAvgEvPct(avgEv: number): string {
  const pct = avgEv * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

function formatCents(cents: number): string {
  return `${Math.round(cents)}¢`;
}

function formatUsd(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}k`;
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

function formatWinRate(winRate?: number): string | null {
  if (winRate == null || !Number.isFinite(winRate)) return null;
  return `${Math.round(winRate * 100)}%`;
}

interface RenderContext {
  whale: string;
  side: string;
  entry: string;
  avgEv: string;
  market: string;
  now: string | null;
  stake: string;
  avgStake: string | null;
  evGloss: string;
  winRate: string | null;
  resolvedBets: string | null;
  postedCount: string | null;
}

function buildRenderContext(
  data: TemplateSchemaInputs,
  random: () => number
): RenderContext {
  return {
    whale: data.whale.trim(),
    side: data.side.trim(),
    entry: formatCents(data.entry),
    avgEv: formatAvgEvPct(data.avg_ev),
    market: data.marketPlain.trim(),
    now:
      data.now != null && Number.isFinite(data.now)
        ? formatCents(data.now)
        : null,
    stake: formatUsd(data.stakeNotional),
    avgStake:
      data.avgStakeNotional != null && Number.isFinite(data.avgStakeNotional)
        ? formatUsd(data.avgStakeNotional)
        : null,
    evGloss: data.evGloss ?? formatEvGloss(data.avg_ev, random),
    winRate: formatWinRate(data.winRate),
    resolvedBets:
      data.resolvedBetsCount != null && Number.isFinite(data.resolvedBetsCount)
        ? data.resolvedBetsCount.toLocaleString("en-US")
        : null,
    postedCount:
      data.postedCount30d != null && Number.isFinite(data.postedCount30d)
        ? String(data.postedCount30d)
        : null,
  };
}

function renderTemplate(family: TemplateFamily, ctx: RenderContext): string {
  switch (family) {
    case "V1":
      return `${ctx.whale} just made a move: ${ctx.side} on ${ctx.market} at ${ctx.entry}. Avg EV: ${ctx.avgEv}.`;
    case "V2": {
      const record =
        ctx.resolvedBets != null
          ? `${ctx.avgEv} avg EV across ${ctx.resolvedBets} resolved bets`
          : `${ctx.avgEv} avg EV`;
      const win =
        ctx.winRate != null ? `, ${ctx.winRate} win rate` : "";
      return `${ctx.whale} (${record}${win}) is ${ctx.side} on ${ctx.market} at ${ctx.entry}.`;
    }
    case "V3":
      if (!ctx.now) {
        throw new TemplateGenerationError("V3 requires now cents when line moved");
      }
      return `${ctx.whale} entered ${ctx.market} at ${ctx.entry} — line now ${ctx.now}. ${ctx.side}. Avg EV: ${ctx.avgEv}.`;
    case "V4":
      if (!ctx.avgStake) {
        throw new TemplateGenerationError("V4 requires stake history");
      }
      return `${ctx.whale} avg stake ${ctx.avgStake} — today ${ctx.stake} on ${ctx.market}. ${ctx.side} at ${ctx.entry}. Track record: ${ctx.avgEv} avg EV.`;
    case "V5":
      return `${ctx.whale} took a contrarian ${ctx.side} on ${ctx.market} at ${ctx.entry}. ${ctx.evGloss}. Avg EV: ${ctx.avgEv}.`;
    case "V6":
      if (!ctx.postedCount) {
        throw new TemplateGenerationError("V6 requires postedCount30d >= 2");
      }
      return `${ctx.whale} is back (${ctx.postedCount} posts this month). ${ctx.side} on ${ctx.market} at ${ctx.entry}. Avg EV: ${ctx.avgEv}.`;
    case "V7":
      if (!ctx.now) {
        throw new TemplateGenerationError("V7 requires now cents when line unchanged");
      }
      return `${ctx.whale} ${ctx.side} on ${ctx.market} at ${ctx.entry} — line still ${ctx.now}. ${ctx.evGloss}. Avg EV: ${ctx.avgEv}.`;
    default:
      throw new TemplateGenerationError(`Unknown template family: ${family}`);
  }
}

/** Strip URLs, siren emojis, and excess / forbidden hashtags from post copy. */
export function sanitizeXPostCopy(text: string): string {
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

export function generateXPostCopy(
  data: TemplateSchemaInputs,
  lastFamilyUsed?: string,
  random = Math.random
): { copyText: string; family: string } {
  assertRequiredSlots(data);

  if (!data.marketPlain?.trim()) {
    throw new TemplateGenerationError("Missing required template slot: marketPlain");
  }

  const family = pickFamily(data, lastFamilyUsed);
  const ctx = buildRenderContext(data, random);
  const raw = renderTemplate(family, ctx);
  const copyText = sanitizeXPostCopy(raw);

  if (!copyText) {
    throw new TemplateGenerationError("Template rendered empty copy after sanitization");
  }

  return { copyText, family };
}
