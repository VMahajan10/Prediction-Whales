import { parseGenericPmGameSlug } from "@/lib/evPipeline/sportsSlugParse";
import {
  countryNameToPm,
  fuzzyCountryNameToPm,
  pmCodeToCountryNames,
} from "@/lib/sportsTeamMatch";
import { normalizePmTeamCode } from "@/lib/teamCodes";
import { translateMarketPositionWithFallback } from "@/lib/marketTranslator";
import {
  formatExplicitNoOutcome,
  sanitizeTemplateSide,
} from "@/lib/x-agent/sideSanitizer";

export interface RawPolymarketTrade {
  source: "polymarket" | "kalshi";
  title: string;
  outcome: string;
  side: "BUY" | "SELL";
  slug?: string | null;
  eventSlug?: string | null;
}

const BINARY_OUTCOMES = new Set(["yes", "no", "true", "false"]);
const PROP_OUTCOMES = new Set(["over", "under", "draw", "tie"]);

function titleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isOpaqueIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^0x[a-f0-9]+$/i.test(trimmed)) return true;
  if (/^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(trimmed)) return true;
  return false;
}

function humanizeOutcomeLabel(outcome: string): string | null {
  const trimmed = outcome.trim();
  if (!trimmed || isOpaqueIdentifier(trimmed)) return null;

  const lower = trimmed.toLowerCase();
  if (BINARY_OUTCOMES.has(lower)) return lower;
  if (PROP_OUTCOMES.has(lower)) return titleCase(lower);

  if (trimmed.length > 4 && /[A-Z]/.test(trimmed[0])) return trimmed;
  if (trimmed.includes(" ")) return trimmed;

  const code = normalizePmTeamCode(lower);
  if (/^[a-z0-9]{2,8}$/i.test(code)) {
    const names = pmCodeToCountryNames(code);
    const readable = names.find(
      (name) =>
        name.length > 3 &&
        name !== code &&
        !/^[a-z]{2,4}$/.test(name) &&
        !name.includes("-")
    );
    if (readable) return titleCase(readable);
    return null;
  }

  if (countryNameToPm(trimmed) || fuzzyCountryNameToPm(trimmed)) {
    return titleCase(trimmed);
  }

  return trimmed;
}

export function humanizeMarketPlain(
  title: string,
  slug?: string | null
): string | null {
  const trimmed = title.trim();
  if (!trimmed) return null;

  const willMatch = trimmed.match(/^Will\s+(.+?)\?$/i);
  if (willMatch) return willMatch[1].trim();

  const vsMatch = trimmed.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\?|:|$)/i);
  if (vsMatch) {
    return `${vsMatch[1].trim()} vs ${vsMatch[2].trim()}`;
  }

  const slugKey = (slug ?? "").trim().toLowerCase();
  const parsed = slugKey ? parseGenericPmGameSlug(slugKey) : null;
  if (parsed) {
    const teamA = humanizeOutcomeLabel(parsed.pmTeamA);
    const teamB = humanizeOutcomeLabel(parsed.pmTeamB);
    if (teamA && teamB) {
      return `${teamA} vs ${teamB}`;
    }
  }

  const cleaned = trimmed.replace(/\?+$/, "").trim();
  return cleaned || null;
}

function resolveNamedSideFromTranslation(
  trade: RawPolymarketTrade
): string | null {
  const { translation, usedFallback } = translateMarketPositionWithFallback(
    {
      title: trade.title,
      slug: trade.slug ?? trade.eventSlug,
      eventSlug: trade.eventSlug,
    },
    {
      outcome: trade.outcome,
      side: trade.side,
    }
  );

  if (usedFallback) {
    return null;
  }

  return sanitizeTemplateSide(translation.sideName);
}

/**
 * Map a Polymarket whale trade to plain-language market + named side copy.
 * Returns null when the trade cannot be expressed with a clean named outcome.
 */
export function translateMarketAndSide(
  trade: RawPolymarketTrade
): { side: string; marketPlain: string } | null {
  if (trade.source !== "polymarket") return null;

  const marketPlain = humanizeMarketPlain(trade.title, trade.slug ?? trade.eventSlug);
  if (!marketPlain) return null;

  const namedSide = resolveNamedSideFromTranslation(trade);
  if (namedSide) {
    return { side: namedSide, marketPlain };
  }

  const outcomeLabel = humanizeOutcomeLabel(trade.outcome);
  if (!outcomeLabel) return null;

  if (BINARY_OUTCOMES.has(outcomeLabel.toLowerCase())) {
    if (outcomeLabel.toLowerCase() === "no") {
      const subject = marketPlain.replace(/\s+vs\s+.+$/i, "").trim();
      return formatExplicitNoOutcome(subject)
        ? { side: formatExplicitNoOutcome(subject)!, marketPlain }
        : null;
    }
    return null;
  }

  const side = sanitizeTemplateSide(outcomeLabel);
  if (!side) return null;

  return { side, marketPlain };
}
