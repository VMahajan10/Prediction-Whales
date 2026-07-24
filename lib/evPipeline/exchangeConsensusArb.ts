import {
  outcomeMatchId,
  parsePmMoneylineSlug,
  type MarketBook,
  type OutcomeBooks,
  type OutcomeSide,
  type ParsedGameKey,
} from "@/lib/crossMarketEv";
import {
  getEnrichedConsensusIndex,
} from "@/lib/evPipeline/consensusIndexBuilder";
import {
  buildLooseParsedGameKey,
  fuzzyTeamTokenFromLabel,
  isSportsMarketProbe,
  parseGameFromPmSlug,
  parseGenericPmGameSlug,
  parseVsTitleTeams,
  probeMentionsTeamToken,
  resolveOutcomePmFromSuffix,
  slugifyTeamToken,
} from "@/lib/evPipeline/sportsSlugParse";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { inferMarketCategory } from "@/lib/marketCategory";
import {
  getOddsApiKey,
  isSportsbookOddsEnabled,
} from "@/lib/sportsbookOdds";
import { findGameInIndex, fuzzyCountryNameToPm, gamesReferToSameMatch, pmCodeToCountryNames } from "@/lib/sportsTeamMatch";
import { normalizePmTeamCode, pmCodeToKalshi, pmTeamCodesEquivalent } from "@/lib/teamCodes";

const GAMMA_API = "https://gamma-api.polymarket.com";

const VS_TITLE =
  /\b(.+?)\s+vs\.?\s+(.+?)(?:\?|$)/i;

const WIN_TITLE =
  /\bwill\s+(?:the\s+)?(.+?)\s+win\b/i;

const PROP_OUTCOMES = new Set(["over", "under", "yes", "no"]);

/** Normalize PM / sportsbook outcome aliases onto a shared token. */
export function normalizeOutcomeLabel(label: string): string {
  const clean = label.toLowerCase().trim();
  if (clean === "over" || clean === "total_over" || clean === "o") return "over";
  if (clean === "under" || clean === "total_under" || clean === "u") return "under";
  if (clean === "yes" || clean === "true") return "yes";
  if (clean === "no" || clean === "false") return "no";
  return clean;
}

function outcomeLabelsMatch(a: string, b: string): boolean {
  const left = normalizeOutcomeLabel(a);
  const right = normalizeOutcomeLabel(b);
  if (left === right) return true;

  const overAliases = new Set(["over", "total_over", "o"]);
  const underAliases = new Set(["under", "total_under", "u"]);
  const yesAliases = new Set(["yes", "true"]);
  const noAliases = new Set(["no", "false"]);

  if (
    (overAliases.has(left) && overAliases.has(right)) ||
    (underAliases.has(left) && underAliases.has(right)) ||
    (yesAliases.has(left) && yesAliases.has(right)) ||
    (noAliases.has(left) && noAliases.has(right))
  ) {
    return true;
  }

  return false;
}

function isPropOutcomeLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  return PROP_OUTCOMES.has(normalizeOutcomeLabel(label));
}

function propOpposingLabel(label: string): string | null {
  const normalized = normalizeOutcomeLabel(label);
  if (normalized === "over") return "under";
  if (normalized === "under") return "over";
  if (normalized === "yes") return "no";
  if (normalized === "no") return "yes";
  return null;
}

function syntheticOutcomeForProp(label: string): OutcomeSide {
  const normalized = normalizeOutcomeLabel(label);
  return normalized === "over" || normalized === "yes" ? "team_a" : "team_b";
}

function normalizedOutcomeFromIndexEntry(
  entry: OutcomeBooks,
  matchId: string
): string {
  const label = entry.label.toLowerCase();
  const suffix = matchId.split("|").pop() ?? "";

  if (label.includes("total_over") || /\btotal\s+over\b/.test(label)) {
    return "over";
  }
  if (label.includes("total_under") || /\btotal\s+under\b/.test(label)) {
    return "under";
  }
  if (/\bover\b/.test(label) && !/\bunder\b/.test(label)) return "over";
  if (/\bunder\b/.test(label)) return "under";
  if (/\byes\b/.test(label) && !/\bno\b/.test(label)) return "yes";
  if (/\bno\b/.test(label)) return "no";

  return normalizeOutcomeLabel(suffix);
}

function parseGameFromTitle(title: string): ParsedGameKey | null {
  const vsLoose = parseVsTitleTeams(title);
  if (vsLoose) {
    return buildLooseParsedGameKey(vsLoose.teamA, vsLoose.teamB, "");
  }

  const vs = title.match(VS_TITLE);
  if (!vs) return null;

  const teamA = fuzzyCountryNameToPm(vs[1]) ?? fuzzyTeamTokenFromLabel(vs[1]);
  const teamB = fuzzyCountryNameToPm(vs[2]) ?? fuzzyTeamTokenFromLabel(vs[2]);
  if (!teamA || !teamB) return null;

  return buildLooseParsedGameKey(teamA, teamB, "");
}

function resolveGameContext(params: {
  slug?: string | null;
  title?: string | null;
  index?: Map<string, OutcomeBooks>;
}): ParsedGameKey | null {
  const slug = params.slug?.trim();
  const title = params.title?.trim();

  if (slug) {
    const fromSlug = parseGameFromSlug(slug);
    if (fromSlug) return fromSlug;
  }

  if (title) {
    const fromTitle = parseGameFromTitle(title);
    if (fromTitle) return fromTitle;
  }

  if (params.index && (title || slug)) {
    const probe = `${slug ?? ""} ${title ?? ""}`.toLowerCase();
    const generic = slug ? parseGenericPmGameSlug(slug) : null;
    const slugTeams = generic
      ? [generic.pmTeamA, generic.pmTeamB]
      : null;

    for (const entry of Array.from(params.index.values())) {
      const indexTeams = [
        normalizePmTeamCode(entry.game.pmTeamA),
        normalizePmTeamCode(entry.game.pmTeamB),
      ];

      const slugAligned =
        slugTeams != null &&
        indexTeams.includes(slugTeams[0]) &&
        indexTeams.includes(slugTeams[1]);

      const probeAligned =
        probeMentionsTeamToken(probe, entry.game.pmTeamA, [entry.label]) &&
        probeMentionsTeamToken(probe, entry.game.pmTeamB, [entry.label]);

      if (slugAligned || probeAligned) {
        return entry.game;
      }
    }
  }

  return null;
}

function findSportsbookByNormalizedOutcome(
  index: Map<string, OutcomeBooks>,
  game: ParsedGameKey,
  normalizedOutcome: string
): { book: MarketBook; matchId: string } | null {
  for (const [matchId, entry] of Array.from(index.entries())) {
    if (!gamesReferToSameMatch(game, entry.game)) continue;
    if (!entry.sportsbook?.bid || !entry.sportsbook?.ask) continue;

    const entryOutcome = normalizedOutcomeFromIndexEntry(entry, matchId);
    if (!outcomeLabelsMatch(normalizedOutcome, entryOutcome)) continue;

    return { book: entry.sportsbook, matchId };
  }

  return null;
}

function findSportsbookByGameAndOutcome(
  index: Map<string, OutcomeBooks>,
  game: ParsedGameKey,
  outcome: OutcomeSide
): { book: MarketBook; matchId: string } | null {
  for (const [matchId, entry] of Array.from(index.entries())) {
    if (entry.outcome !== outcome) continue;
    if (!entry.sportsbook?.bid || !entry.sportsbook?.ask) continue;
    if (!gamesReferToSameMatch(game, entry.game)) continue;
    return { book: entry.sportsbook, matchId };
  }
  return null;
}

function invertPropSportsbookBook(
  book: MarketBook,
  targetOutcome: string
): MarketBook | null {
  if (book.bid == null || book.ask == null) return null;

  const ask = roundProb(1 - book.ask);
  const bid = roundProb(1 - book.bid);
  if (bid <= 0 || ask <= 0 || bid >= ask) return null;

  return {
    ...book,
    bid,
    ask,
    mid: roundProb((bid + ask) / 2),
    spread: roundProb(ask - bid),
    label: `${book.label} (aligned to ${normalizeOutcomeLabel(targetOutcome)})`,
  };
}

function resolvePropPmOutcome(params: {
  slug?: string | null;
  title?: string | null;
  outcomeName: string;
  index?: Map<string, OutcomeBooks>;
}): ResolvedPmOutcome | null {
  const normalized = normalizeOutcomeLabel(params.outcomeName);
  if (!PROP_OUTCOMES.has(normalized)) return null;

  const game = resolveGameContext({
    slug: params.slug,
    title: params.title,
    index: params.index,
  });
  if (!game) return null;

  const outcome = syntheticOutcomeForProp(normalized);

  return {
    game,
    outcome,
    outcomePm: normalized,
    outcomeLabel: params.outcomeName.trim(),
    matchId: outcomeMatchId(game, outcome),
  };
}

function resolvePmOutcomeFromIndexByProp(
  index: Map<string, OutcomeBooks>,
  outcomeName: string,
  params: { slug?: string | null; title?: string | null }
): ResolvedPmOutcome | null {
  const normalized = normalizeOutcomeLabel(outcomeName);
  if (!PROP_OUTCOMES.has(normalized)) return null;

  const probe = `${params.slug ?? ""} ${params.title ?? ""}`.toLowerCase();
  let best: { entry: OutcomeBooks; matchId: string; score: number } | null =
    null;

  for (const [matchId, entry] of Array.from(index.entries())) {
    if (!entry.sportsbook?.bid || !entry.sportsbook?.ask) continue;

    const entryOutcome = normalizedOutcomeFromIndexEntry(entry, matchId);
    if (!outcomeLabelsMatch(normalized, entryOutcome)) continue;

    let score = 5;
    const pmA = entry.game.pmTeamA.toLowerCase();
    const pmB = entry.game.pmTeamB.toLowerCase();
    if (probe.includes(pmA) && probe.includes(pmB)) score += 4;
    if (params.title && entry.label.toLowerCase().includes(params.title.toLowerCase().slice(0, 24))) {
      score += 2;
    }

    if (!best || score > best.score) {
      best = { entry, matchId, score };
    }
  }

  if (!best) return null;

  return {
    game: best.entry.game,
    outcome: best.entry.outcome,
    outcomePm: normalized,
    outcomeLabel: outcomeName.trim(),
    matchId: best.matchId,
  };
}

function probeMentionsPmTeam(
  probe: string,
  pmCode: string,
  label = ""
): boolean {
  return probeMentionsTeamToken(probe, pmCode, label ? [label] : []);
}

function isSportsPropContext(
  slug?: string | null,
  title?: string | null
): boolean {
  if (isSportsSlugOrTitle(slug ?? undefined, title ?? undefined)) return true;
  const probe = `${slug ?? ""} ${title ?? ""}`.toLowerCase();
  return /\b(over|under|o\/u|total|spread|btts|goals)\b/.test(probe);
}

function binaryPlaceholderGame(
  slug?: string | null,
  title?: string | null
): ParsedGameKey {
  return {
    date: new Date().toISOString().slice(0, 10),
    kalshiTeamA: "YES",
    kalshiTeamB: "NO",
    pmTeamA: "yes",
    pmTeamB: "no",
    kickoffEpochSec: null,
    kickoffKnown: false,
  };
}

function resolveBinaryYesNoOutcome(params: {
  outcomeName: string;
  slug?: string | null;
  title?: string | null;
}): ResolvedPmOutcome | null {
  const normalized = normalizeOutcomeLabel(params.outcomeName);
  if (!PROP_OUTCOMES.has(normalized)) return null;
  if (isSportsSlugOrTitle(params.slug ?? undefined, params.title ?? undefined)) {
    return null;
  }

  const game = binaryPlaceholderGame(params.slug, params.title);
  const outcome = syntheticOutcomeForProp(normalized);
  const marketKey = slugifyTeamToken(
    `${params.slug ?? ""}-${params.title ?? "market"}`
  );

  return {
    game,
    outcome,
    outcomePm: normalized,
    outcomeLabel: params.outcomeName.trim(),
    matchId: `binary|${normalized}|${marketKey || "market"}`,
  };
}

function resolveDrawOutcome(params: {
  slug?: string | null;
  title?: string | null;
  outcomeName?: string | null;
  index?: Map<string, OutcomeBooks>;
}): ResolvedPmOutcome | null {
  const slug = params.slug?.trim();
  const title = params.title?.trim();
  const outcomeName = params.outcomeName?.trim() || null;

  if (slug) {
    const parsed = parseSlugGameAndOutcome(slug);
    if (parsed?.outcome === "draw") {
      return buildResolvedPmOutcome(
        parsed.game,
        "draw",
        outcomeName ?? "Draw"
      );
    }
  }

  const drawProbe = `${outcomeName ?? ""} ${title ?? ""}`.trim();
  if (!/\b(draw|tie)\b/i.test(drawProbe)) return null;

  const game = resolveGameContext({
    slug,
    title,
    index: params.index,
  });
  if (!game) return null;

  return buildResolvedPmOutcome(game, "draw", outcomeName ?? "Draw");
}

export interface ExchangeConsensusBaseline {
  /** Canonical match id in the cross-market index. */
  matchId: string;
  /** PM token outcome side this baseline is aligned to. */
  outcome: OutcomeSide;
  /** PM team code for the YES contract (e.g. prt). */
  outcomePm: string | null;
  /** Human-readable team/outcome label from the PM token (e.g. "Spain"). */
  outcomeLabel?: string | null;
  yesBid: number;
  yesAsk: number;
  label: string;
  bookmakerCount: number;
  quoteUpdatedAt: number | null;
  source: "sportsbook";
  /** True when prices were derived by inverting the opposing team's book. */
  invertedFromOpposing?: boolean;
}

export interface ResolvedPmOutcome {
  game: ParsedGameKey;
  outcome: OutcomeSide;
  outcomePm: string | null;
  /** Human-readable outcome from Gamma (e.g. "Spain", "Portugal"). */
  outcomeLabel: string | null;
  matchId: string;
}

interface GammaMarketRow {
  slug?: string;
  question?: string;
  outcomes?: string | string[];
  clobTokenIds?: string | string[];
}

interface PmMarketForToken {
  slug: string | null;
  question: string | null;
  outcomeName: string | null;
}

function parseGammaStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseSlugGameAndOutcome(slug: string): {
  game: ParsedGameKey;
  outcome: OutcomeSide | null;
  outcomePm: string | null;
} | null {
  const strict = parsePmMoneylineSlug(slug);
  if (strict) {
    return {
      game: strict.game,
      outcome: strict.outcome,
      outcomePm: strict.outcomePm,
    };
  }

  const generic = parseGenericPmGameSlug(slug);
  if (!generic) return null;

  const game = buildLooseParsedGameKey(
    generic.pmTeamA,
    generic.pmTeamB,
    generic.date
  );

  const token = generic.suffix;
  let outcome: OutcomeSide | null = null;
  if (token === "draw" || token === "tie") outcome = "draw";
  else if (token && pmTeamCodesEquivalent(token, generic.pmTeamA)) {
    outcome = "team_a";
  } else if (token && pmTeamCodesEquivalent(token, generic.pmTeamB)) {
    outcome = "team_b";
  } else if (token && isPropOutcomeLabel(token)) {
    outcome = syntheticOutcomeForProp(normalizeOutcomeLabel(token));
  }

  return {
    game,
    outcome,
    outcomePm: resolveOutcomePmFromSuffix(
      token,
      generic.pmTeamA,
      generic.pmTeamB
    ),
  };
}

function indexToGameMap(
  index: Map<string, OutcomeBooks>
): Map<string, { game: ParsedGameKey }> {
  const games = new Map<string, { game: ParsedGameKey }>();
  for (const [id, entry] of Array.from(index.entries())) {
    games.set(id, { game: entry.game });
  }
  return games;
}

function resolveMatchIdFromTitle(
  index: Map<string, OutcomeBooks>,
  title: string
): string | null {
  const vsLoose = parseVsTitleTeams(title);
  if (vsLoose) {
    const gameIndex = indexToGameMap(index);
    const today = new Date().toISOString().slice(0, 10);
    const game = findGameInIndex(gameIndex, today, vsLoose.teamA, vsLoose.teamB, {
      dateToleranceDays: 14,
    });
    if (game) {
      const probe = title.toLowerCase();
      let outcome: OutcomeSide | null = null;
      if (/\b(draw|tie)\b/i.test(probe)) outcome = "draw";
      else if (
        probeMentionsTeamToken(probe, game.pmTeamA) &&
        !probeMentionsTeamToken(probe, game.pmTeamB)
      ) {
        outcome = "team_a";
      } else if (
        probeMentionsTeamToken(probe, game.pmTeamB) &&
        !probeMentionsTeamToken(probe, game.pmTeamA)
      ) {
        outcome = "team_b";
      }
      if (outcome) return outcomeMatchId(game, outcome);
    }
  }

  const vs = title.match(VS_TITLE);
  if (vs) {
    const teamA =
      fuzzyCountryNameToPm(vs[1]) ?? fuzzyTeamTokenFromLabel(vs[1]);
    const teamB =
      fuzzyCountryNameToPm(vs[2]) ?? fuzzyTeamTokenFromLabel(vs[2]);
    if (teamA && teamB) {
      const gameIndex = indexToGameMap(index);
      const today = new Date().toISOString().slice(0, 10);
      const game = findGameInIndex(gameIndex, today, teamA, teamB, {
        dateToleranceDays: 14,
      });
      if (game) {
        const probe = title.toLowerCase();
        const pmA = game.pmTeamA.toLowerCase();
        const pmB = game.pmTeamB.toLowerCase();

        let outcome: OutcomeSide | null = null;
        if (/\b(draw|tie)\b/i.test(probe)) outcome = "draw";
        else if (probeMentionsPmTeam(probe, game.pmTeamA) && !probeMentionsPmTeam(probe, game.pmTeamB)) {
          outcome = "team_a";
        } else if (probeMentionsPmTeam(probe, game.pmTeamB) && !probeMentionsPmTeam(probe, game.pmTeamA)) {
          outcome = "team_b";
        }

        if (outcome) return outcomeMatchId(game, outcome);
      }
    }
  }

  const win = title.match(WIN_TITLE);
  if (!win) return null;

  const teamPm = fuzzyCountryNameToPm(win[1]);
  if (!teamPm) return null;

  const normalizedTeam = normalizePmTeamCode(teamPm);
  let best: { matchId: string; score: number } | null = null;

  for (const [matchId, entry] of Array.from(index.entries())) {
    if (!entry.sportsbook?.bid || !entry.sportsbook?.ask) continue;

    const isTeamA = normalizePmTeamCode(entry.game.pmTeamA) === normalizedTeam;
    const isTeamB = normalizePmTeamCode(entry.game.pmTeamB) === normalizedTeam;
    if (!isTeamA && !isTeamB) continue;

    const expectedOutcome: OutcomeSide = isTeamA ? "team_a" : "team_b";
    if (entry.outcome !== expectedOutcome) continue;

    let score = 5;
    if (probeMentionsPmTeam(title, teamPm, entry.label)) score += 3;

    if (!best || score > best.score) {
      best = { matchId, score };
    }
  }

  return best?.matchId ?? null;
}

function roundProb(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function getOpposingOutcome(outcome: OutcomeSide): OutcomeSide | null {
  if (outcome === "team_a") return "team_b";
  if (outcome === "team_b") return "team_a";
  return null;
}

function parseGameFromSlug(slug: string): ParsedGameKey | null {
  const parsed = parseSlugGameAndOutcome(slug);
  if (parsed) return parsed.game;
  return parseGameFromPmSlug(slug);
}

function resolveOutcomeSideForGame(
  game: ParsedGameKey,
  teamLabel: string
): OutcomeSide | null {
  const trimmed = teamLabel.trim();
  if (!trimmed) return null;
  if (/\b(draw|tie)\b/i.test(trimmed)) return "draw";

  const teamPm =
    fuzzyCountryNameToPm(trimmed) ?? fuzzyTeamTokenFromLabel(trimmed);
  if (!teamPm) return null;

  if (pmTeamCodesEquivalent(game.pmTeamA, teamPm)) return "team_a";
  if (pmTeamCodesEquivalent(game.pmTeamB, teamPm)) return "team_b";

  const token = slugifyTeamToken(trimmed);
  if (token && pmTeamCodesEquivalent(game.pmTeamA, token)) return "team_a";
  if (token && pmTeamCodesEquivalent(game.pmTeamB, token)) return "team_b";

  return null;
}

function buildResolvedPmOutcome(
  game: ParsedGameKey,
  outcome: OutcomeSide,
  outcomeLabel: string | null
): ResolvedPmOutcome {
  return {
    game,
    outcome,
    outcomePm: outcomePmCode(game, outcome),
    outcomeLabel,
    matchId: outcomeMatchId(game, outcome),
  };
}

/**
 * Invert an opposing-side sportsbook YES ask onto the PM token's outcome.
 * exchangeYesAskForTeamA = 1.00 - exchangeYesAskForTeamB
 */
export function invertSportsbookToTargetOutcome(
  book: MarketBook,
  fromOutcome: OutcomeSide,
  targetOutcome: OutcomeSide
): MarketBook | null {
  const opposing = getOpposingOutcome(targetOutcome);
  if (!opposing || fromOutcome !== opposing) return null;
  if (book.bid == null || book.ask == null) return null;

  const ask = roundProb(1 - book.ask);
  const bid = roundProb(1 - book.bid);
  if (bid <= 0 || ask <= 0 || bid >= ask) return null;

  return {
    ...book,
    bid,
    ask,
    mid: roundProb((bid + ask) / 2),
    spread: roundProb(ask - bid),
    label: `${book.label} (aligned to ${targetOutcome})`,
  };
}

function outcomePmCode(game: ParsedGameKey, outcome: OutcomeSide): string | null {
  if (outcome === "team_a") return game.pmTeamA;
  if (outcome === "team_b") return game.pmTeamB;
  return "draw";
}

function resolveOutcomeFromWinTitle(
  title: string,
  game: ParsedGameKey
): OutcomeSide | null {
  if (/\b(?:end|finish|result)(?:\s+\w+){0,6}\s+(?:in\s+)?(?:a\s+)?(?:draw|tie)\b|\b(?:draw|tie)\s*\?/i.test(title)) {
    return "draw";
  }

  const win = title.match(WIN_TITLE);
  if (!win) return null;

  const teamPm = fuzzyCountryNameToPm(win[1]) ?? fuzzyTeamTokenFromLabel(win[1]);
  if (!teamPm) return null;

  if (pmTeamCodesEquivalent(game.pmTeamA, teamPm)) return "team_a";
  if (pmTeamCodesEquivalent(game.pmTeamB, teamPm)) return "team_b";
  return null;
}

/** Resolve the exact PM CLOB outcome (team/draw/prop/binary) for a token. */
export function resolvePmTokenOutcome(params: {
  slug?: string | null;
  title?: string | null;
  outcomeName?: string | null;
  index?: Map<string, OutcomeBooks>;
}): ResolvedPmOutcome | null {
  const slug = params.slug?.trim();
  const title = params.title?.trim();
  const outcomeName = params.outcomeName?.trim() || null;

  if (slug && isSportsSlugOrTitle(slug, title)) {
    const parsed = parseSlugGameAndOutcome(slug);
    if (parsed?.outcome) {
      const label =
        outcomeName ??
        (parsed.outcomePm
          ? pmCodeToCountryNames(parsed.outcomePm)[0] ?? parsed.outcomePm
          : null);
      return buildResolvedPmOutcome(parsed.game, parsed.outcome, label);
    }

    const game = parseGameFromSlug(slug);
    if (game) {
      const fromDraw = resolveDrawOutcome({
        slug,
        title,
        outcomeName,
        index: params.index,
      });
      if (fromDraw) return fromDraw;

      if (outcomeName) {
        const fromOutcomeName = resolveOutcomeSideForGame(game, outcomeName);
        if (fromOutcomeName) {
          return buildResolvedPmOutcome(game, fromOutcomeName, outcomeName);
        }
      }

      if (title) {
        const fromTitle = resolveOutcomeFromWinTitle(title, game);
        if (fromTitle) {
          const win = title.match(WIN_TITLE);
          return buildResolvedPmOutcome(
            game,
            fromTitle,
            win?.[1]?.trim() ?? outcomeName
          );
        }
      }
    }
  }

  const fromDraw = resolveDrawOutcome({
    slug,
    title,
    outcomeName,
    index: params.index,
  });
  if (fromDraw) return fromDraw;

  if (outcomeName && isPropOutcomeLabel(outcomeName) && isSportsPropContext(slug, title)) {
    const fromProp = resolvePropPmOutcome({
      slug,
      title,
      outcomeName,
      index: params.index,
    });
    if (fromProp) return fromProp;
  }

  if (outcomeName && title) {
    const win = title.match(WIN_TITLE);
    const teamPm = fuzzyCountryNameToPm(outcomeName);
    if (teamPm && win) {
      const teamA = fuzzyCountryNameToPm(win[1]);
      const teamB = fuzzyCountryNameToPm(
        title.match(VS_TITLE)?.[2] ?? ""
      );
      if (teamA && teamB) {
        const kalshiA = pmCodeToKalshi(teamA);
        const kalshiB = pmCodeToKalshi(teamB);
        if (kalshiA && kalshiB) {
          const game: ParsedGameKey = {
            date: new Date().toISOString().slice(0, 10),
            kalshiTeamA: kalshiA,
            kalshiTeamB: kalshiB,
            pmTeamA: teamA,
            pmTeamB: teamB,
            kickoffEpochSec: null,
            kickoffKnown: false,
          };
          const outcome = resolveOutcomeSideForGame(game, outcomeName);
          if (outcome) {
            return buildResolvedPmOutcome(game, outcome, outcomeName);
          }
        }
      }
    }
  }

  if (outcomeName) {
    const fromBinary = resolveBinaryYesNoOutcome({
      outcomeName,
      slug,
      title,
    });
    if (fromBinary) return fromBinary;
  }

  return null;
}

function resolveSportsbookForPmOutcome(
  index: Map<string, OutcomeBooks>,
  target: ResolvedPmOutcome
): { book: MarketBook; matchId: string; inverted: boolean } | null {
  if (isPropOutcomeLabel(target.outcomePm ?? target.outcomeLabel)) {
    const normalized = normalizeOutcomeLabel(
      target.outcomePm ?? target.outcomeLabel ?? ""
    );
    const direct = findSportsbookByNormalizedOutcome(index, target.game, normalized);
    if (direct) {
      return { book: direct.book, matchId: direct.matchId, inverted: false };
    }

    const opposing = propOpposingLabel(normalized);
    if (opposing) {
      const opp = findSportsbookByNormalizedOutcome(index, target.game, opposing);
      if (opp?.book.bid != null && opp.book.ask != null) {
        const inverted = invertPropSportsbookBook(opp.book, normalized);
        if (inverted?.ask != null) {
          console.warn(
            "[exchangeConsensusArb] inverted opposing prop sportsbook to PM outcome",
            {
              pmOutcome: normalized,
              opposingOutcome: opposing,
              opposingMatchId: opp.matchId,
              opposingYesAsk: opp.book.ask,
              alignedYesAsk: inverted.ask,
              alignedNoAsk: roundProb(1 - inverted.ask),
            }
          );
          return { book: inverted, matchId: opp.matchId, inverted: true };
        }
      }
    }

    return null;
  }

  const direct = index.get(target.matchId);
  if (
    direct?.outcome === target.outcome &&
    direct?.sportsbook?.bid &&
    direct?.sportsbook?.ask
  ) {
    return {
      book: direct.sportsbook,
      matchId: target.matchId,
      inverted: false,
    };
  }

  const byGame = findSportsbookByGameAndOutcome(index, target.game, target.outcome);
  if (byGame) {
    console.log("[exchangeConsensusArb] sportsbook matched by normalized teams", {
      pmMatchId: target.matchId,
      resolvedMatchId: byGame.matchId,
      pmTeams: [target.game.pmTeamA, target.game.pmTeamB],
      outcome: target.outcome,
    });
    return { book: byGame.book, matchId: byGame.matchId, inverted: false };
  }

  const opposing = getOpposingOutcome(target.outcome);
  if (!opposing) return null;

  const opposingId = outcomeMatchId(target.game, opposing);
  const oppEntry = index.get(opposingId);
  const oppByGame = findSportsbookByGameAndOutcome(index, target.game, opposing);
  const opposingBook = oppEntry?.sportsbook ?? oppByGame?.book ?? null;

  if (!opposingBook?.bid || !opposingBook?.ask) return null;

  const inverted = invertSportsbookToTargetOutcome(
    opposingBook,
    opposing,
    target.outcome
  );
  if (!inverted || inverted.ask == null) return null;

  console.warn("[exchangeConsensusArb] inverted opposing sportsbook to PM outcome", {
    pmMatchId: target.matchId,
    opposingMatchId: oppByGame?.matchId ?? opposingId,
    targetOutcome: target.outcome,
    outcomePm: target.outcomePm,
    outcomeLabel: target.outcomeLabel,
    opposingYesAsk: opposingBook.ask,
    alignedYesAsk: inverted.ask,
    alignedNoAsk: roundProb(1 - (inverted.ask ?? 0)),
  });

  return {
    book: inverted,
    matchId: oppByGame?.matchId ?? target.matchId,
    inverted: true,
  };
}

function isSportsSlugOrTitle(slug?: string | null, title?: string | null): boolean {
  if (isSportsMarketProbe(slug, title)) return true;
  if (inferMarketCategory(`${slug ?? ""} ${title ?? ""}`) === "SPORTS") {
    return true;
  }
  return false;
}

function bookToBaseline(
  book: MarketBook,
  matchId: string,
  outcome: OutcomeSide,
  outcomePm: string | null,
  invertedFromOpposing = false,
  outcomeLabel: string | null = null
): ExchangeConsensusBaseline | null {
  if (
    book.bid == null ||
    book.ask == null ||
    !Number.isFinite(book.bid) ||
    !Number.isFinite(book.ask) ||
    book.bid <= 0 ||
    book.ask <= 0 ||
    book.bid >= book.ask
  ) {
    return null;
  }

  return {
    matchId,
    outcome,
    outcomePm,
    outcomeLabel,
    yesBid: book.bid,
    yesAsk: book.ask,
    label: book.label,
    bookmakerCount: book.label.includes("books") ? 2 : 2,
    quoteUpdatedAt: book.quoteUpdatedAt,
    source: "sportsbook",
    invertedFromOpposing,
  };
}

async function fetchPmMarketForToken(
  tokenId: string
): Promise<PmMarketForToken> {
  try {
    const res = await fetchWithTimeout(
      `${GAMMA_API}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`,
      {
        headers: { Accept: "application/json", "User-Agent": "MarketPulse/1.0" },
        cache: "no-store",
        timeoutMs: 8000,
      }
    );
    if (!res.ok) return { slug: null, question: null, outcomeName: null };
    const rows = (await res.json()) as GammaMarketRow[];
    if (!Array.isArray(rows) || !rows[0]) {
      return { slug: null, question: null, outcomeName: null };
    }

    const row = rows[0];
    const outcomes = parseGammaStringArray(row.outcomes);
    const tokenIds = parseGammaStringArray(row.clobTokenIds);
    const tokenIndex = tokenIds.findIndex(
      (id) => id.toLowerCase() === tokenId.toLowerCase()
    );
    const outcomeName =
      tokenIndex >= 0 ? outcomes[tokenIndex]?.trim() || null : null;

    return {
      slug: row.slug ?? null,
      question: row.question ?? null,
      outcomeName,
    };
  } catch {
    return { slug: null, question: null, outcomeName: null };
  }
}

export function resolveSportsMatchId(params: {
  slug?: string | null;
  title?: string | null;
}): string | null {
  const slug = params.slug?.trim();
  const title = params.title?.trim();

  if (slug && isSportsSlugOrTitle(slug, title)) {
    const parsed = parseSlugGameAndOutcome(slug);
    if (parsed?.outcome) {
      return outcomeMatchId(parsed.game, parsed.outcome);
    }
  }

  return null;
}

/**
 * Resolve Pinnacle/Betfair no-vig consensus from the cross-market EV cache
 * for a Polymarket sports moneyline token or slug.
 */
export async function lookupExchangeConsensusBaseline(params: {
  tokenId?: string | null;
  slug?: string | null;
  title?: string | null;
}): Promise<ExchangeConsensusBaseline | null> {
  if (!isSportsbookOddsEnabled()) {
    console.warn(
      "[exchangeConsensusArb] ODDS_API_KEY missing — sportsbook consensus unavailable",
      { hasKey: !!getOddsApiKey() }
    );
  }

  let slug = params.slug?.trim() || null;
  let title = params.title?.trim() || null;
  let outcomeName: string | null = null;

  if (params.tokenId) {
    const gamma = await fetchPmMarketForToken(params.tokenId);
    outcomeName = gamma.outcomeName;
    if (!slug && gamma.slug) slug = gamma.slug;
    if (!title && gamma.question) title = gamma.question;
    console.log("[exchangeConsensusArb] gamma market for token", {
      tokenId: params.tokenId,
      slugFromToken: gamma.slug,
      questionFromToken: gamma.question,
      outcomeNameFromToken: gamma.outcomeName,
    });
  }

  const index = await getEnrichedConsensusIndex();

  let pmOutcome = resolvePmTokenOutcome({
    slug,
    title,
    outcomeName,
    index,
  });

  console.log("[exchangeConsensusArb] resolve attempt", {
    tokenId: params.tokenId ?? null,
    slug,
    title,
    outcomeName,
    normalizedOutcome: outcomeName ? normalizeOutcomeLabel(outcomeName) : null,
    pmOutcome,
  });

  if (!pmOutcome && outcomeName) {
    pmOutcome = resolvePmOutcomeFromIndexByProp(index, outcomeName, {
      slug,
      title,
    });
    if (pmOutcome) {
      console.log("[exchangeConsensusArb] prop index-derived pm outcome", pmOutcome);
    }
  }

  if (!pmOutcome && title) {
    const titleMatchId = resolveMatchIdFromTitle(index, title);
    if (titleMatchId) {
      const entry = index.get(titleMatchId);
      if (entry) {
        pmOutcome = buildResolvedPmOutcome(
          entry.game,
          entry.outcome,
          outcomeName ?? entry.label
        );
        console.log("[exchangeConsensusArb] title-derived pm outcome", pmOutcome);
      }
    }
  }

  if (!pmOutcome) {
    console.warn("[exchangeConsensusArb] no PM outcome resolved — refusing misaligned baseline", {
      tokenId: params.tokenId ?? null,
      slug,
      title,
      outcomeName,
      indexSize: index.size,
    });
    return null;
  }

  const aligned = resolveSportsbookForPmOutcome(index, pmOutcome);
  if (aligned) {
    const cachedBaseline = bookToBaseline(
      aligned.book,
      aligned.matchId,
      pmOutcome.outcome,
      pmOutcome.outcomePm,
      aligned.inverted,
      pmOutcome.outcomeLabel
    );
    console.log("[exchangeConsensusArb] aligned sportsbook baseline", {
      baseline: cachedBaseline,
      pmOutcomeLabel: pmOutcome.outcomeLabel,
      inverted: aligned.inverted,
      exchangeNoAsk:
        cachedBaseline != null
          ? roundProb(1 - cachedBaseline.yesAsk)
          : null,
    });
    return cachedBaseline;
  }

  console.warn("[exchangeConsensusArb] no aligned sportsbook for PM outcome", {
    tokenId: params.tokenId ?? null,
    slug,
    title,
    pmOutcome,
    indexSize: index.size,
    sportsbookOddsEnabled: isSportsbookOddsEnabled(),
  });
  return null;
}

export function exchangeBaselineToYesNoAsks(
  baseline: ExchangeConsensusBaseline
): { yesAsk: number; noAsk: number; yesBid: number } {
  const yesAsk = baseline.yesAsk;
  const noAsk = roundProb(1 - yesAsk);
  return {
    yesBid: baseline.yesBid,
    yesAsk,
    noAsk:
      Number.isFinite(noAsk) && noAsk > 0 && noAsk < 1 ? noAsk : roundProb(1 - yesAsk),
  };
}
