import {
  gameMatchId,
  parseKalshiGameTicker,
  parsePmMoneylineSlug,
  type ParsedGameKey,
} from "@/lib/crossMarketEv";
import { countryNameToPm } from "@/lib/sportsTeamMatch";
import { kalshiLineFromOutcome, type SportsMarketKind } from "@/lib/evPipeline/sportsStructureMatch";
import {
  buildLooseParsedGameKey,
  fuzzyTeamTokenFromLabel,
  parseGameFromPmSlug,
  parseGenericPmGameSlug,
  parseVsTitleTeams,
} from "@/lib/evPipeline/sportsSlugParse";

const LINE_TEXT =
  /\b(?:o\/u|over\/under|over under|total|line)\s*(\d+(?:\.\d+)?)\b/i;

/** Default spread volatility (runs/goals) for normal margin model. */
const DEFAULT_SPREAD_SIGMA = 1.75;

export interface SportsDerivativeSpec {
  gameId: string;
  game: ParsedGameKey;
  kind: SportsMarketKind;
  line: number | null;
  /** YES leg direction for totals/spreads. */
  side: "over" | "under" | "yes" | null;
  /** PM team code when this contract is a team-outcome (moneyline / advance). */
  teamOutcomePm: string | null;
  /** Kalshi outcome suffix (team code, T35, RSA3CAN2, …). */
  kalshiOutcome: string | null;
}

export interface GameProbabilityAnchor {
  gameId: string;
  game: ParsedGameKey;
  teamWinPTrue: Record<string, number>;
  poissonLambda: number | null;
  calibratedFromLine: number | null;
  calibratedFromPTrue: number | null;
}

export interface DeriveSportsPTrueResult {
  pTrue: number;
  method: string;
  detail: string;
}

function clampProb(p: number): number {
  return Math.max(0.001, Math.min(0.999, p));
}

function buildGameKey(pmA: string, pmB: string, date: string): ParsedGameKey {
  return buildLooseParsedGameKey(pmA, pmB, date);
}

function inferKind(text: string): SportsMarketKind {
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
  if (text.includes("score")) return "score";
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

function inferSide(text: string): "over" | "under" | "yes" | null {
  if (/\bunder\b|\bu\s*\d/.test(text)) return "under";
  if (/\bover\b|\bo\s*\/?\s*u\b|\btotal\b/.test(text)) return "over";
  return "yes";
}

function parseGameFromTitle(title: string): ParsedGameKey | null {
  const vsLoose = parseVsTitleTeams(title);
  if (vsLoose) {
    return buildGameKey(vsLoose.teamA, vsLoose.teamB, "");
  }

  const m = title.match(/\b(.+?)\s+vs\.?\s+(.+?)(?:\?|$)/i);
  if (!m) return null;
  const pmA = countryNameToPm(m[1]) ?? fuzzyTeamTokenFromLabel(m[1]);
  const pmB = countryNameToPm(m[2]) ?? fuzzyTeamTokenFromLabel(m[2]);
  if (!pmA || !pmB) return null;
  return buildGameKey(pmA, pmB, "");
}

function kalshiSeriesKind(series: string): SportsMarketKind {
  const key = series.replace(/^KX/i, "").toUpperCase();
  if (key.includes("TOTAL")) return "total";
  if (key.includes("SPREAD")) return "spread";
  if (key.includes("SCORE")) return "score";
  if (key.includes("GAME") || key === "WC") return "moneyline";
  return "unknown";
}

function teamPmFromKalshiOutcome(
  game: ParsedGameKey,
  outcomeKalshi: string
): string | null {
  const upper = outcomeKalshi.toUpperCase();
  if (upper === game.kalshiTeamA) return game.pmTeamA;
  if (upper === game.kalshiTeamB) return game.pmTeamB;
  return null;
}

/** Parse a mapped PM↔Kalshi pair into a sports derivative specification. */
export function parseSportsDerivativeFromMapping(input: {
  polymarketTitle: string;
  kalshiTitle: string;
  kalshiTicker: string;
  slug?: string | null;
  eventSlug?: string | null;
}): SportsDerivativeSpec | null {
  const slug = (input.slug ?? input.eventSlug ?? "").toLowerCase();
  const corpus = `${slug} ${input.polymarketTitle} ${input.kalshiTitle}`.toLowerCase();

  const kalshiParsed = parseKalshiGameTicker(input.kalshiTicker);
  let game: ParsedGameKey | null = kalshiParsed?.game ?? null;
  let kind: SportsMarketKind = kalshiParsed
    ? kalshiSeriesKind(kalshiParsed.series)
    : inferKind(corpus);
  let line =
    kalshiParsed != null
      ? kalshiLineFromOutcome(kalshiParsed.outcomeKalshi)
      : null;
  let teamOutcomePm =
    kalshiParsed != null
      ? teamPmFromKalshiOutcome(kalshiParsed.game, kalshiParsed.outcomeKalshi)
      : null;

  if (slug) {
    const moneyline = parsePmMoneylineSlug(slug);
    if (moneyline) {
      game = moneyline.game;
      kind = "moneyline";
      teamOutcomePm = moneyline.outcomePm;
      line = null;
    } else {
      const generic = parseGenericPmGameSlug(slug);
      if (generic) {
        game = buildGameKey(generic.pmTeamA, generic.pmTeamB, generic.date);
        const suffix = generic.suffix ?? "";
        if (kind === "unknown") kind = inferKind(`${suffix} ${corpus}`);
        line = line ?? extractLine(corpus) ?? parseLineFromSlugSuffix(suffix);
      } else {
        game = parseGameFromPmSlug(slug);
      }
    }
  }

  if (!game) {
    game = parseGameFromTitle(input.polymarketTitle);
  }

  if (!game) return null;

  line = line ?? extractLine(corpus);
  const side = inferSide(corpus);

  return {
    gameId: gameMatchId(game),
    game,
    kind,
    line,
    side,
    teamOutcomePm,
    kalshiOutcome: kalshiParsed?.outcomeKalshi ?? null,
  };
}

function poissonPmf(k: number, lambda: number): number {
  if (k < 0 || lambda <= 0) return k === 0 && lambda <= 0 ? 1 : 0;
  let logFact = 0;
  for (let i = 2; i <= k; i++) logFact += Math.log(i);
  return Math.exp(k * Math.log(lambda) - lambda - logFact);
}

/** P(X > line) for half-lines — e.g. line 3.5 ⇒ P(X ≥ 4). */
export function poissonOverProbability(lambda: number, line: number): number {
  const threshold = Math.floor(line + 0.5);
  let cdf = 0;
  for (let k = 0; k < threshold; k++) {
    cdf += poissonPmf(k, lambda);
  }
  return clampProb(1 - cdf);
}

export function calibratePoissonLambda(line: number, overProb: number): number {
  const target = clampProb(overProb);
  let lo = 0.05;
  let hi = 40;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const p = poissonOverProbability(mid, line);
    if (p > target) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const prob =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - prob : prob;
}

function spreadCoverProbability(
  favoriteMarginMean: number,
  spreadLine: number,
  sigma: number
): number {
  const z = (favoriteMarginMean - spreadLine) / sigma;
  return clampProb(normalCdf(z));
}

function parseExactScoreOutcome(outcome: string): { a: number; b: number } | null {
  const m = outcome.toUpperCase().match(/^([A-Z]{3})(\d)([A-Z]{3})(\d)$/);
  if (!m) return null;
  return { a: parseInt(m[2], 10), b: parseInt(m[4], 10) };
}

function scoreExactProbability(
  anchor: GameProbabilityAnchor,
  score: { a: number; b: number }
): number | null {
  if (anchor.poissonLambda == null) return null;
  const teamA = anchor.game.pmTeamA;
  const pA = anchor.teamWinPTrue[teamA];
  const pB = anchor.teamWinPTrue[anchor.game.pmTeamB];
  if (pA == null || pB == null) return null;

  const shareA = pA / Math.max(pA + pB, 0.001);
  const lambdaA = anchor.poissonLambda * shareA;
  const lambdaB = anchor.poissonLambda * (1 - shareA);
  return clampProb(poissonPmf(score.a, lambdaA) * poissonPmf(score.b, lambdaB));
}

export function createGameAnchorStore(): Map<string, GameProbabilityAnchor> {
  return new Map();
}

export function getOrCreateGameAnchor(
  store: Map<string, GameProbabilityAnchor>,
  spec: SportsDerivativeSpec
): GameProbabilityAnchor {
  const existing = store.get(spec.gameId);
  if (existing) return existing;

  const anchor: GameProbabilityAnchor = {
    gameId: spec.gameId,
    game: spec.game,
    teamWinPTrue: {},
    poissonLambda: null,
    calibratedFromLine: null,
    calibratedFromPTrue: null,
  };
  store.set(spec.gameId, anchor);
  return anchor;
}

/** Record ensemble output from a primary (moneyline / anchor total) mapping. */
export function updateGameAnchorFromPrimary(
  store: Map<string, GameProbabilityAnchor>,
  spec: SportsDerivativeSpec,
  pTrue: number,
  marketPrior: number
): void {
  const anchor = getOrCreateGameAnchor(store, spec);

  if (spec.kind === "moneyline" && spec.teamOutcomePm) {
    const team = spec.teamOutcomePm.toLowerCase();
    anchor.teamWinPTrue[team] = clampProb(pTrue);
    const otherTeam =
      spec.game.pmTeamA.toLowerCase() === team
        ? spec.game.pmTeamB.toLowerCase()
        : spec.game.pmTeamA.toLowerCase();
    if (anchor.teamWinPTrue[otherTeam] == null) {
      anchor.teamWinPTrue[otherTeam] = clampProb(1 - pTrue);
    }
  }

  if (
    spec.kind === "total" &&
    spec.line != null &&
    anchor.poissonLambda == null
  ) {
    const overProb =
      spec.side === "under" ? 1 - pTrue : spec.side === "over" ? pTrue : pTrue;
    anchor.poissonLambda = calibratePoissonLambda(spec.line, overProb);
    anchor.calibratedFromLine = spec.line;
    anchor.calibratedFromPTrue = pTrue;
  }

  if (Object.keys(anchor.teamWinPTrue).length === 0 && spec.kind === "moneyline") {
    anchor.teamWinPTrue[spec.game.pmTeamA] = clampProb(marketPrior);
    anchor.teamWinPTrue[spec.game.pmTeamB] = clampProb(1 - marketPrior);
  }
}

/**
 * Derive a unique p_true for O/U, spread, and exact-score contracts from
 * anchored moneyline / primary-total probabilities.
 */
export function deriveSportsDerivativePTrue(
  spec: SportsDerivativeSpec,
  store: Map<string, GameProbabilityAnchor>,
  marketPrior: number
): DeriveSportsPTrueResult | null {
  const anchor = store.get(spec.gameId);
  if (!anchor) return null;

  if (spec.kind === "moneyline" && spec.teamOutcomePm) {
    const team = spec.teamOutcomePm.toLowerCase();
    const anchored = anchor.teamWinPTrue[team];
    if (anchored != null) {
      return {
        pTrue: anchored,
        method: "sports_anchor_moneyline",
        detail: `team=${team}`,
      };
    }
  }

  if (spec.kind === "total" && spec.line != null) {
    let lambda = anchor.poissonLambda;
    if (lambda == null && anchor.calibratedFromLine != null) {
      lambda = calibratePoissonLambda(
        anchor.calibratedFromLine,
        anchor.calibratedFromPTrue ?? marketPrior
      );
    }
    if (lambda == null) {
      const pA = anchor.teamWinPTrue[spec.game.pmTeamA] ?? marketPrior;
      lambda = 2.5 + 5 * Math.abs(pA - 0.5);
    }

    let overP = poissonOverProbability(lambda, spec.line);
    if (spec.side === "under") overP = 1 - overP;

    return {
      pTrue: clampProb(overP),
      method: "sports_poisson_total",
      detail: `line=${spec.line} lambda=${lambda.toFixed(3)}`,
    };
  }

  if (spec.kind === "spread" && spec.line != null) {
    const pA = anchor.teamWinPTrue[spec.game.pmTeamA];
    const pB = anchor.teamWinPTrue[spec.game.pmTeamB];
    if (pA == null || pB == null) return null;

    const favoriteIsA = pA >= pB;
    const favProb = favoriteIsA ? pA : pB;
    const meanMargin = DEFAULT_SPREAD_SIGMA * Math.sqrt(2) * (normalCdf(favProb) - 0.5) * 2;
    const signedLine = favoriteIsA ? spec.line : -spec.line;
    const cover = spreadCoverProbability(meanMargin, signedLine, DEFAULT_SPREAD_SIGMA);

    return {
      pTrue: clampProb(cover),
      method: "sports_normal_spread",
      detail: `line=${spec.line} meanMargin=${meanMargin.toFixed(2)}`,
    };
  }

  if (spec.kind === "score" && spec.kalshiOutcome) {
    return deriveExactScorePTrue(spec, store, spec.kalshiOutcome);
  }

  return null;
}

/** Parse exact score from Kalshi ticker suffix for score-series markets. */
export function deriveExactScorePTrue(
  spec: SportsDerivativeSpec,
  store: Map<string, GameProbabilityAnchor>,
  kalshiOutcome: string
): DeriveSportsPTrueResult | null {
  if (spec.kind !== "score") return null;
  const anchor = store.get(spec.gameId);
  if (!anchor) return null;

  const score = parseExactScoreOutcome(kalshiOutcome);
  if (!score) return null;

  const p = scoreExactProbability(anchor, score);
  if (p == null) return null;

  return {
    pTrue: p,
    method: "sports_poisson_exact_score",
    detail: `score=${score.a}-${score.b}`,
  };
}

export function sportsMappingKindPriority(kind: SportsMarketKind): number {
  switch (kind) {
    case "moneyline":
      return 0;
    case "total":
      return 1;
    case "spread":
      return 2;
    case "score":
      return 3;
    default:
      return 4;
  }
}

export function sortMappingsForSportsAnchors<
  T extends { polymarketTitle: string; kalshiTitle: string; kalshiTicker: string }
>(mappings: T[]): T[] {
  return [...mappings].sort((a, b) => {
    const sa =
      parseSportsDerivativeFromMapping(a)?.kind ?? ("unknown" as SportsMarketKind);
    const sb =
      parseSportsDerivativeFromMapping(b)?.kind ?? ("unknown" as SportsMarketKind);
    return sportsMappingKindPriority(sa) - sportsMappingKindPriority(sb);
  });
}
