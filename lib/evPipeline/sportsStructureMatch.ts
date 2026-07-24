import {
  parseKalshiGameTicker,
  parsePmMoneylineSlug,
  type ParsedGameKey,
} from "@/lib/crossMarketEv";
import { contractsMappingCompatible } from "@/lib/evPipeline/marketCategoryMatch";
import { parseGenericPmGameSlug, buildLooseParsedGameKey } from "@/lib/evPipeline/sportsSlugParse";
import { countryNameToPm, teamsMatchGame } from "@/lib/sportsTeamMatch";
import { normalizePmTeamCode, pmCodeToKalshi } from "@/lib/teamCodes";
import type { MatchedPair, NormalizedMarketContract } from "@/lib/evPipeline/types";

const PM_GAME_SLUG =
  /^fifwc-([a-z]+)-([a-z]+)-(\d{4}-\d{2}-\d{2})(?:-(.*))?$/i;

const VS_TITLE =
  /\b([a-z][a-z\s'’.\-]{1,40}?)\s+(?:vs\.?|versus|v\.?)\s+([a-z][a-z\s'’.\-]{1,40}?)\b/i;

const LINE_TEXT =
  /\b(?:o\/u|over\/under|over under|total|line)\s*(\d+(?:\.\d+)?)\b/i;

const DRAW_TITLE =
  /\b(?:end|finish|result)(?:\s+\w+){0,6}\s+(?:in\s+)?(?:a\s+)?(?:draw|tie)\b|\b(?:draw|tie)\s*\?/i;

const TEAM_WIN_TITLE =
  /\bwill\s+(?:the\s+)?(.+?)\s+(?:win|advance|qualify)\b/i;

export type SportsMarketKind = "moneyline" | "total" | "spread" | "score" | "unknown";

export type PmOutcomeLeg =
  | { type: "team"; pmTeamCode: string; kalshiTeamCode: string }
  | { type: "draw" }
  | { type: "unspecified" };

interface ParsedPmSports {
  game: ParsedGameKey;
  kind: SportsMarketKind;
  line: number | null;
  outcomeLeg: PmOutcomeLeg | null;
}

function buildGameKey(
  pmA: string,
  pmB: string,
  date: string
): ParsedGameKey | null {
  const kalshiA = pmCodeToKalshi(pmA);
  const kalshiB = pmCodeToKalshi(pmB);
  if (!kalshiA || !kalshiB) return null;

  return {
    date,
    kalshiTeamA: kalshiA,
    kalshiTeamB: kalshiB,
    pmTeamA: pmA,
    pmTeamB: pmB,
    kickoffEpochSec: null,
    kickoffKnown: false,
  };
}

function parseTeamOutcomeLeg(pmTeamCode: string): PmOutcomeLeg | null {
  const normalized = normalizePmTeamCode(pmTeamCode);
  const kalshiTeamCode = pmCodeToKalshi(normalized);
  if (!kalshiTeamCode) return null;
  return { type: "team", pmTeamCode: normalized, kalshiTeamCode };
}

function teamCodeInGame(pmTeamCode: string, game: ParsedGameKey): boolean {
  const normalized = normalizePmTeamCode(pmTeamCode);
  return (
    normalized === normalizePmTeamCode(game.pmTeamA) ||
    normalized === normalizePmTeamCode(game.pmTeamB)
  );
}

function parseOutcomeLegFromSlugSuffix(
  suffix: string,
  game: ParsedGameKey
): PmOutcomeLeg | null {
  const token = suffix.trim().toLowerCase();
  if (!token) return null;
  if (token === "draw" || token === "tie") return { type: "draw" };
  if (teamCodeInGame(token, game)) return parseTeamOutcomeLeg(token);
  return null;
}

function parseOutcomeLegFromTitle(
  title: string,
  game: ParsedGameKey
): PmOutcomeLeg | null {
  if (DRAW_TITLE.test(title)) return { type: "draw" };

  const winMatch = title.match(TEAM_WIN_TITLE);
  if (winMatch) {
    const pmTeam = countryNameToPm(winMatch[1]);
    if (pmTeam && teamCodeInGame(pmTeam, game)) {
      return parseTeamOutcomeLeg(pmTeam);
    }
  }

  return null;
}

function resolvePmOutcomeLeg(
  contract: NormalizedMarketContract,
  game: ParsedGameKey,
  kind: SportsMarketKind,
  slugSuffix: string | null
): PmOutcomeLeg | null {
  if (kind !== "moneyline") return { type: "unspecified" };

  const slug = (contract.slug ?? contract.eventSlug ?? "").toLowerCase();
  if (slug) {
    const moneyline = parsePmMoneylineSlug(slug);
    if (moneyline) {
      if (moneyline.outcomePm === "draw") return { type: "draw" };
      if (teamCodeInGame(moneyline.outcomePm, game)) {
        return parseTeamOutcomeLeg(moneyline.outcomePm);
      }
      return null;
    }
  }

  if (slugSuffix) {
    const fromSuffix = parseOutcomeLegFromSlugSuffix(slugSuffix, game);
    if (fromSuffix) return fromSuffix;
  }

  return parseOutcomeLegFromTitle(contract.title, game);
}

/** Exported for tests — strict PM ↔ Kalshi outcome leg alignment. */
export function sportsOutcomeLegsAligned(
  pmInfo: ParsedPmSports,
  kalshiOutcomeKalshi: string,
  kalshiKind: SportsMarketKind
): boolean {
  const kalshiLeg = kalshiOutcomeKalshi.toUpperCase();

  if (pmInfo.kind === "moneyline" && kalshiKind === "moneyline") {
    const leg = pmInfo.outcomeLeg;
    if (!leg || leg.type === "unspecified") return false;
    if (leg.type === "draw") return kalshiLeg === "TIE";
    if (leg.type === "team") return kalshiLeg === leg.kalshiTeamCode.toUpperCase();
    return false;
  }

  if (
    pmInfo.kind === "total" ||
    pmInfo.kind === "spread" ||
    kalshiKind === "total" ||
    kalshiKind === "spread" ||
    kalshiKind === "score"
  ) {
    return true;
  }

  if (pmInfo.kind === "moneyline" || kalshiKind === "moneyline") {
    const leg = pmInfo.outcomeLeg;
    if (!leg || leg.type === "unspecified") return false;
    if (leg.type === "draw") return kalshiLeg === "TIE";
    if (leg.type === "team") return kalshiLeg === leg.kalshiTeamCode.toUpperCase();
    return false;
  }

  return true;
}

function inferKindFromText(text: string): SportsMarketKind {
  if (
    text.includes("o/u") ||
    text.includes("over/under") ||
    text.includes("over under") ||
    text.includes("total")
  ) {
    return "total";
  }
  if (text.includes("spread")) return "spread";
  if (text.includes("advance") || text.includes("winner")) return "moneyline";
  return "unknown";
}

function extractLine(text: string): number | null {
  const m = text.match(LINE_TEXT);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseLineFromSlugSuffix(suffix: string): number | null {
  const pt = suffix.match(/(\d+)pt(\d+)/i);
  if (pt) return parseFloat(`${pt[1]}.${pt[2]}`);

  const dash = suffix.match(/(?:total|spread)-(\d+)-(\d+)/i);
  if (dash) return parseFloat(`${dash[1]}.${dash[2]}`);

  return extractLine(suffix);
}

function parseGameFromTitle(title: string): ParsedGameKey | null {
  const m = title.match(VS_TITLE);
  if (!m) return null;

  const pmA = countryNameToPm(m[1]);
  const pmB = countryNameToPm(m[2]);
  if (!pmA || !pmB) return null;

  return buildGameKey(pmA, pmB, "");
}

function parsePmSportsContract(
  contract: NormalizedMarketContract
): ParsedPmSports | null {
  const slug = (contract.slug ?? contract.eventSlug ?? "").toLowerCase();
  const corpus = `${slug} ${contract.title}`.toLowerCase();

  if (slug) {
    const moneyline = parsePmMoneylineSlug(slug);
    if (moneyline) {
      const outcomeLeg = resolvePmOutcomeLeg(
        contract,
        moneyline.game,
        "moneyline",
        null
      );
      return {
        game: moneyline.game,
        kind: "moneyline",
        line: null,
        outcomeLeg,
      };
    }

    const gameSlug = slug.match(PM_GAME_SLUG);
    if (gameSlug) {
      const [, pmA, pmB, date, suffixRaw] = gameSlug;
      const game = buildGameKey(pmA, pmB, date);
      if (!game) return null;

      const suffix = (suffixRaw ?? "").toLowerCase();
      let kind = inferKindFromText(`${suffix} ${corpus}`);
      if (kind === "unknown" && suffix && !suffix.includes("total")) {
        kind = "moneyline";
      }

      const outcomeLeg = resolvePmOutcomeLeg(
        contract,
        game,
        kind,
        suffix || null
      );

      return {
        game,
        kind,
        line: extractLine(corpus) ?? parseLineFromSlugSuffix(suffix),
        outcomeLeg,
      };
    }

    const genericSlug = parseGenericPmGameSlug(slug);
    if (genericSlug) {
      const game = buildLooseParsedGameKey(
        genericSlug.pmTeamA,
        genericSlug.pmTeamB,
        genericSlug.date
      );
      let kind = inferKindFromText(`${genericSlug.suffix ?? ""} ${corpus}`);
      if (kind === "unknown" && genericSlug.suffix) {
        kind = "moneyline";
      }

      const outcomeLeg = resolvePmOutcomeLeg(
        contract,
        game,
        kind,
        genericSlug.suffix
      );

      return {
        game,
        kind,
        line: extractLine(corpus) ?? parseLineFromSlugSuffix(genericSlug.suffix ?? ""),
        outcomeLeg,
      };
    }
  }

  const titleGame = parseGameFromTitle(contract.title);
  if (titleGame) {
    let kind = inferKindFromText(corpus);
    if (
      kind === "unknown" &&
      (DRAW_TITLE.test(contract.title) || TEAM_WIN_TITLE.test(contract.title))
    ) {
      kind = "moneyline";
    }
    const outcomeLeg = resolvePmOutcomeLeg(contract, titleGame, kind, null);
    return {
      game: titleGame,
      kind,
      line: extractLine(corpus),
      outcomeLeg,
    };
  }

  return null;
}

function kalshiSeriesKind(series: string): SportsMarketKind {
  const key = series.replace(/^KX/i, "").toUpperCase();
  if (key.includes("TOTAL")) return "total";
  if (key.includes("SPREAD")) return "spread";
  if (key.includes("SCORE")) return "score";
  if (key.includes("GAME") || key === "WC") return "moneyline";
  return "unknown";
}

/** Kalshi suffix e.g. T35 → 3.5, T05 → 0.5 for O/U lines. */
export function kalshiLineFromOutcome(outcome: string): number | null {
  const o = outcome.toUpperCase();
  const tMatch = o.match(/^T(\d+)$/);
  if (tMatch) {
    const raw = parseInt(tMatch[1], 10);
    if (!Number.isFinite(raw)) return null;
    if (raw < 10) return raw / 10;
    if (raw % 10 === 5) return raw / 10;
    return raw / 10;
  }

  if (/^\d+$/.test(o) && o.length <= 3) {
    const raw = parseInt(o, 10);
    return raw >= 10 ? raw / 10 : raw;
  }

  return null;
}

function kindsCompatible(
  pm: SportsMarketKind,
  kalshi: SportsMarketKind
): boolean {
  if (pm === "unknown" || kalshi === "unknown") return true;
  if (pm === kalshi) return true;
  if (pm === "moneyline" && kalshi === "moneyline") return true;
  return false;
}

function linesCompatible(pmLine: number | null, kalshiOutcome: string): boolean {
  const kLine = kalshiLineFromOutcome(kalshiOutcome);
  if (pmLine == null && kLine == null) return true;
  if (pmLine == null || kLine == null) {
    if (kLine == null && /^[A-Z]{3}$/i.test(kalshiOutcome)) return true;
    return pmLine == null;
  }
  return Math.abs(pmLine - kLine) < 0.01;
}

function gamesMatch(pmGame: ParsedGameKey, kalshiGame: ParsedGameKey): boolean {
  return teamsMatchGame(kalshiGame, pmGame.pmTeamA, pmGame.pmTeamB);
}

/**
 * Deterministic PM ↔ Kalshi pairing for World Cup / cricket derivatives.
 * Allows multiple mappings per fixture (O/U, spread, advance) — no greedy 1:1 cap.
 */
export function matchSportsStructurePairs(
  polymarket: NormalizedMarketContract[],
  kalshi: NormalizedMarketContract[]
): MatchedPair[] {
  const matches: MatchedPair[] = [];
  const seen = new Set<string>();

  const kalshiParsed = kalshi
    .map((contract) => ({
      contract,
      parsed: parseKalshiGameTicker(contract.tokenOrTicker),
    }))
    .filter(
      (
        row
      ): row is {
        contract: NormalizedMarketContract;
        parsed: NonNullable<ReturnType<typeof parseKalshiGameTicker>>;
      } => row.parsed != null
    );

  for (const pm of polymarket) {
    const pmInfo = parsePmSportsContract(pm);
    if (!pmInfo) continue;

    for (const { contract: km, parsed } of kalshiParsed) {
      if (!contractsMappingCompatible(pm, km)) continue;
      if (!gamesMatch(pmInfo.game, parsed.game)) continue;

      const kKind = kalshiSeriesKind(parsed.series);
      if (!kindsCompatible(pmInfo.kind, kKind)) continue;
      if (!linesCompatible(pmInfo.line, parsed.outcomeKalshi)) continue;
      if (
        !sportsOutcomeLegsAligned(pmInfo, parsed.outcomeKalshi, kKind)
      ) {
        continue;
      }

      const dedupeKey = `${pm.tokenOrTicker.toLowerCase()}:${km.tokenOrTicker.toUpperCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      matches.push({
        polymarketTokenId: pm.tokenOrTicker.toLowerCase(),
        polymarketConditionId: pm.externalId,
        kalshiTicker: km.tokenOrTicker.toUpperCase(),
        similarity: 0.95,
        rawSimilarity: 0.95,
        polymarketTitle: pm.title,
        kalshiTitle: km.title,
        matchMethod: "sports_structure",
      });
    }
  }

  return matches;
}

/** Merge match groups — sports structure pairs coexist with vector matches. */
export function mergeMatchedPairs(...groups: MatchedPair[][]): MatchedPair[] {
  const byKey = new Map<string, MatchedPair>();

  for (const group of groups) {
    for (const match of group) {
      const key = `${match.polymarketTokenId.toLowerCase()}:${match.kalshiTicker.toUpperCase()}`;
      const existing = byKey.get(key);
      if (!existing || match.similarity > existing.similarity) {
        byKey.set(key, match);
      }
    }
  }

  return Array.from(byKey.values());
}
