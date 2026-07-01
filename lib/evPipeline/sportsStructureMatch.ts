import {
  parseKalshiGameTicker,
  parsePmMoneylineSlug,
  type ParsedGameKey,
} from "@/lib/crossMarketEv";
import { countryNameToPm, teamsMatchGame } from "@/lib/sportsTeamMatch";
import { pmCodeToKalshi } from "@/lib/teamCodes";
import type { MatchedPair, NormalizedMarketContract } from "@/lib/evPipeline/types";

const PM_GAME_SLUG =
  /^fifwc-([a-z]+)-([a-z]+)-(\d{4}-\d{2}-\d{2})(?:-(.*))?$/i;

const VS_TITLE =
  /\b([a-z][a-z\s'’.\-]{1,40}?)\s+(?:vs\.?|versus|v\.?)\s+([a-z][a-z\s'’.\-]{1,40}?)\b/i;

const LINE_TEXT =
  /\b(?:o\/u|over\/under|over under|total|line)\s*(\d+(?:\.\d+)?)\b/i;

export type SportsMarketKind = "moneyline" | "total" | "spread" | "score" | "unknown";

interface ParsedPmSports {
  game: ParsedGameKey;
  kind: SportsMarketKind;
  line: number | null;
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
      return { game: moneyline.game, kind: "moneyline", line: null };
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

      return {
        game,
        kind,
        line: extractLine(corpus) ?? parseLineFromSlugSuffix(suffix),
      };
    }
  }

  const titleGame = parseGameFromTitle(contract.title);
  if (titleGame) {
    return {
      game: titleGame,
      kind: inferKindFromText(corpus),
      line: extractLine(corpus),
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
      if (!gamesMatch(pmInfo.game, parsed.game)) continue;

      const kKind = kalshiSeriesKind(parsed.series);
      if (!kindsCompatible(pmInfo.kind, kKind)) continue;
      if (!linesCompatible(pmInfo.line, parsed.outcomeKalshi)) continue;

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
