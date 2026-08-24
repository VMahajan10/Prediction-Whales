import { parseGenericPmGameSlug } from "@/lib/evPipeline/sportsSlugParse";
import { pmCodeToCountryNames } from "@/lib/sportsTeamMatch";
import { normalizePmTeamCode } from "@/lib/teamCodes";

export interface TranslatableMarket {
  title: string;
  slug?: string | null;
  eventSlug?: string | null;
  outcomes?: readonly string[] | null;
  endDate?: string | null;
}

export interface MarketPosition {
  outcome: string;
  side?: "BUY" | "SELL";
}

export interface MarketPositionTranslation {
  backingLabel: string;
  sideName: string;
  exitByLabel?: string;
}

type OutcomeToken = "YES" | "NO" | "NAMED";

interface MatchupCandidates {
  candidateA: string;
  candidateB: string;
}

function titleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function humanizeTeamCode(code: string): string | null {
  const normalized = normalizePmTeamCode(code);
  if (!normalized) return null;

  const names = pmCodeToCountryNames(normalized);
  const readable = names.find(
    (name) =>
      name.length > 2 &&
      name !== normalized &&
      !/^[a-z]{2,4}$/i.test(name) &&
      !name.includes("-")
  );
  if (readable) return titleCase(readable);
  if (/^[a-z0-9]{2,8}$/i.test(normalized)) return normalized.toUpperCase();
  return null;
}

function cleanCandidateLabel(value: string): string | null {
  const trimmed = value
    .trim()
    .replace(/\?+$/g, "")
    .replace(/^the\s+/i, "")
    .trim();
  if (!trimmed || /^0x[a-f0-9]+$/i.test(trimmed)) return null;
  return titleCase(trimmed);
}

function parseTitleMatchup(title: string): MatchupCandidates | null {
  const vsMatch = title.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\?|:|\s+winner|\s+to\s+win|$)/i);
  if (!vsMatch) return null;

  const candidateA = cleanCandidateLabel(vsMatch[1] ?? "");
  const candidateB = cleanCandidateLabel(vsMatch[2] ?? "");
  if (!candidateA || !candidateB) return null;
  return { candidateA, candidateB };
}

function parseSlugMatchup(
  slug?: string | null,
  eventSlug?: string | null
): MatchupCandidates | null {
  const slugKey = (slug ?? eventSlug ?? "").trim().toLowerCase();
  if (!slugKey) return null;

  const parsed = parseGenericPmGameSlug(slugKey);
  if (!parsed) return null;

  const candidateA = humanizeTeamCode(parsed.pmTeamA);
  const candidateB = humanizeTeamCode(parsed.pmTeamB);
  if (!candidateA || !candidateB) return null;
  return { candidateA, candidateB };
}

function parseDeclaredOutcomes(
  outcomes?: readonly string[] | null
): MatchupCandidates | null {
  if (!outcomes || outcomes.length !== 2) return null;

  const candidateA = cleanCandidateLabel(outcomes[0] ?? "");
  const candidateB = cleanCandidateLabel(outcomes[1] ?? "");
  if (!candidateA || !candidateB) return null;
  return { candidateA, candidateB };
}

function resolveMatchupCandidates(market: TranslatableMarket): MatchupCandidates | null {
  return (
    parseDeclaredOutcomes(market.outcomes) ??
    parseTitleMatchup(market.title) ??
    parseSlugMatchup(market.slug, market.eventSlug)
  );
}

function parseWillSubject(title: string): string | null {
  const match = title.trim().match(/^Will\s+(.+?)\?$/i);
  if (!match) return null;
  return cleanCandidateLabel(match[1] ?? "");
}

function classifyOutcome(outcome: string): OutcomeToken {
  const normalized = normalizeToken(outcome);
  if (normalized === "yes" || normalized === "true") return "YES";
  if (normalized === "no" || normalized === "false") return "NO";
  return "NAMED";
}

function namesMatch(a: string, b: string): boolean {
  const left = normalizeToken(a);
  const right = normalizeToken(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.includes(right) || right.includes(left);
}

function resolveNamedSide(
  outcome: string,
  matchup: MatchupCandidates
): string | null {
  if (namesMatch(outcome, matchup.candidateA)) return matchup.candidateA;
  if (namesMatch(outcome, matchup.candidateB)) return matchup.candidateB;
  const cleaned = cleanCandidateLabel(outcome);
  if (!cleaned) return null;
  if (namesMatch(cleaned, matchup.candidateA)) return matchup.candidateA;
  if (namesMatch(cleaned, matchup.candidateB)) return matchup.candidateB;
  return null;
}

export function formatExitByLabel(endDate?: string | null): string | undefined {
  if (!endDate?.trim()) return undefined;

  const parsed = new Date(endDate);
  if (Number.isNaN(parsed.getTime())) return undefined;

  const formatted = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
  return `Exit by ${formatted}`;
}

function buildTranslation(sideName: string, endDate?: string | null): MarketPositionTranslation {
  return {
    backingLabel: `Backing ${sideName}`,
    sideName,
    exitByLabel: formatExitByLabel(endDate),
  };
}

/**
 * Translate a market position into plain-language feed copy.
 * Returns null when the position cannot be expressed without raw YES/NO tokens.
 */
export function translateMarketPosition(
  market: TranslatableMarket,
  position: MarketPosition
): MarketPositionTranslation | null {
  const matchup = resolveMatchupCandidates(market);
  const outcomeToken = classifyOutcome(position.outcome);

  if (matchup) {
    if (outcomeToken === "YES") {
      return buildTranslation(matchup.candidateA, market.endDate);
    }
    if (outcomeToken === "NO") {
      return buildTranslation(matchup.candidateB, market.endDate);
    }

    const namedSide = resolveNamedSide(position.outcome, matchup);
    if (namedSide) {
      return buildTranslation(namedSide, market.endDate);
    }

    return null;
  }

  if (outcomeToken === "NO") {
    return null;
  }

  if (outcomeToken === "YES") {
    const subject = parseWillSubject(market.title);
    if (subject) {
      return buildTranslation(subject, market.endDate);
    }
    return null;
  }

  const namedOutcome = cleanCandidateLabel(position.outcome);
  if (namedOutcome) {
    return buildTranslation(namedOutcome, market.endDate);
  }

  return null;
}

function cleanMarketTitleForFallback(title: string): string {
  const cleaned = title
    .trim()
    .replace(/\?+$/g, "")
    .replace(/^Will\s+/i, "")
    .trim();
  return cleaned || "market";
}

function formatFallbackOutcomeLabel(outcome: string): string {
  const outcomeToken = classifyOutcome(outcome);
  if (outcomeToken === "YES") return "yes";
  if (outcomeToken === "NO") return "no";
  const named = cleanCandidateLabel(outcome);
  return (named ?? outcome.trim()).toLowerCase();
}

/**
 * Plain-language fallback when custom matchup / will-question mapping fails.
 * Produces copy like "bought yes" + market title for feed / queue rendering.
 */
export function buildMarketTranslationFallback(
  market: TranslatableMarket,
  position: MarketPosition
): MarketPositionTranslation {
  const verb = position.side === "SELL" ? "sold" : "bought";
  const outcomeLabel = formatFallbackOutcomeLabel(position.outcome);
  const marketTitle = cleanMarketTitleForFallback(market.title);

  return {
    backingLabel: `${verb} ${outcomeLabel}`,
    sideName: marketTitle,
    exitByLabel: formatExitByLabel(market.endDate),
  };
}

export function translateMarketPositionWithFallback(
  market: TranslatableMarket,
  position: MarketPosition
): { translation: MarketPositionTranslation; usedFallback: boolean } {
  const primary = translateMarketPosition(market, position);
  if (primary) {
    return { translation: primary, usedFallback: false };
  }

  return {
    translation: buildMarketTranslationFallback(market, position),
    usedFallback: true,
  };
}

export interface WhaleTradeTranslationInput {
  title: string;
  outcome: string;
  side?: "BUY" | "SELL";
  slug?: string | null;
  eventSlug?: string | null;
  endDate?: string | null;
  outcomes?: readonly string[] | null;
}

export function translateWhaleTradeMarket(
  trade: WhaleTradeTranslationInput
): MarketPositionTranslation | null {
  return translateMarketPosition(
    {
      title: trade.title,
      slug: trade.slug,
      eventSlug: trade.eventSlug,
      endDate: trade.endDate,
      outcomes: trade.outcomes,
    },
    {
      outcome: trade.outcome,
      side: trade.side,
    }
  );
}
