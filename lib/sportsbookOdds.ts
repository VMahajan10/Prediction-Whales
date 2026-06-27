import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import {
  fetchPmGameMoneylines,
  outcomeMatchId,
  type MarketBook,
  type OutcomeBooks,
  type OutcomeSide,
  type ParsedGameKey,
} from "@/lib/crossMarketEv";
import { normalizePmTeamCode, pmCodeToKalshi, pmEventSlugCodeVariants } from "@/lib/teamCodes";
import {
  adjacentDates,
  countryNameToPm,
  findGameInIndex,
  outcomeForWinner,
  teamsMatchGame,
} from "@/lib/sportsTeamMatch";

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const FETCH_TIMEOUT_MS = 10000;
const DEFAULT_SPORT_KEY = "soccer_fifa_world_cup";

export function getOddsApiKey(): string | null {
  const key =
    process.env.ODDS_API_KEY ??
    process.env.THE_ODDS_API_KEY ??
    process.env.ODDS_API_KEY_FREE;
  return key?.trim() || null;
}

export function isSportsbookOddsEnabled(): boolean {
  return !!getOddsApiKey();
}

/** American odds → raw implied probability (0–1). */
export function americanToImplied(american: number): number | null {
  if (!Number.isFinite(american) || american === 0) return null;
  if (american > 0) return 100 / (american + 100);
  const abs = Math.abs(american);
  return abs / (abs + 100);
}

/** Two-way no-vig: normalize two implied probs to sum to 1. */
export function removeVigTwoWay(
  probA: number,
  probB: number
): { a: number; b: number } | null {
  const sum = probA + probB;
  if (sum <= 0 || !Number.isFinite(sum)) return null;
  return { a: probA / sum, b: probB / sum };
}

/** Three-way no-vig (soccer h2h with draw). */
export function removeVigThreeWay(
  home: number,
  away: number,
  draw: number
): { home: number; away: number; draw: number } | null {
  const sum = home + away + draw;
  if (sum <= 0 || !Number.isFinite(sum)) return null;
  return { home: home / sum, away: away / sum, draw: draw / sum };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

interface OddsOutcome {
  name: string;
  price: number;
}

interface OddsMarket {
  key: string;
  last_update?: string;
  outcomes?: OddsOutcome[];
}

interface OddsBookmaker {
  key: string;
  last_update?: string;
  markets?: OddsMarket[];
}

export interface OddsApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: OddsBookmaker[];
}

export interface SportsbookEventConsensus {
  eventId: string;
  commenceTime: string;
  date: string;
  homePm: string;
  awayPm: string;
  homeTeam: string;
  awayTeam: string;
  /** No-vig consensus probabilities. */
  home: number;
  away: number;
  draw: number;
  bookmakerCount: number;
  quoteUpdatedAt: number;
}

function parseIsoSec(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function consensusFromBookmakers(
  event: OddsApiEvent,
  homeTeam: string,
  awayTeam: string
): Omit<SportsbookEventConsensus, "eventId" | "commenceTime" | "date" | "homePm" | "awayPm" | "homeTeam" | "awayTeam"> | null {
  const homeNv: number[] = [];
  const awayNv: number[] = [];
  const drawNv: number[] = [];
  let latestUpdate = 0;

  for (const book of event.bookmakers ?? []) {
    const h2h = book.markets?.find((m) => m.key === "h2h");
    if (!h2h?.outcomes?.length) continue;

    const byName = new Map(
      h2h.outcomes.map((o) => [o.name.toLowerCase(), o.price])
    );
    const homePrice = byName.get(homeTeam.toLowerCase());
    const awayPrice = byName.get(awayTeam.toLowerCase());
    const drawPrice = byName.get("draw");

    if (homePrice == null || awayPrice == null) continue;

    const homeRaw = americanToImplied(homePrice);
    const awayRaw = americanToImplied(awayPrice);
    if (homeRaw == null || awayRaw == null) continue;

    let nv: { home: number; away: number; draw: number } | null;

    if (drawPrice != null) {
      const drawRaw = americanToImplied(drawPrice);
      if (drawRaw == null) continue;
      nv = removeVigThreeWay(homeRaw, awayRaw, drawRaw);
    } else {
      const two = removeVigTwoWay(homeRaw, awayRaw);
      if (!two) continue;
      nv = { home: two.a, away: two.b, draw: 0 };
    }

    if (!nv) continue;

    homeNv.push(nv.home);
    awayNv.push(nv.away);
    drawNv.push(nv.draw);

    const bookUpdate =
      parseIsoSec(h2h.last_update) ?? parseIsoSec(book.last_update) ?? 0;
    if (bookUpdate > latestUpdate) latestUpdate = bookUpdate;
  }

  const homeMed = median(homeNv);
  const awayMed = median(awayNv);
  const drawMed = median(drawNv);

  if (homeMed == null || awayMed == null || drawMed == null) return null;
  if (homeNv.length < 2) return null;

  return {
    home: Math.round(homeMed * 1000) / 1000,
    away: Math.round(awayMed * 1000) / 1000,
    draw: Math.round(drawMed * 1000) / 1000,
    bookmakerCount: homeNv.length,
    quoteUpdatedAt: latestUpdate || Math.floor(Date.now() / 1000),
  };
}

/** Fetch FIFA World Cup h2h moneylines from The Odds API. */
export async function fetchOddsApiWorldCupEvents(): Promise<
  SportsbookEventConsensus[]
> {
  const apiKey = getOddsApiKey();
  if (!apiKey) return [];

  const sportKey = process.env.ODDS_API_SPORT_KEY ?? DEFAULT_SPORT_KEY;
  const params = new URLSearchParams({
    apiKey,
    regions: "us,uk,eu",
    markets: "h2h",
    oddsFormat: "american",
  });

  try {
    const res = await fetchWithTimeout(
      `${ODDS_API_BASE}/sports/${sportKey}/odds?${params}`,
      {
        headers: { Accept: "application/json" },
        timeoutMs: FETCH_TIMEOUT_MS,
      }
    );

    if (!res.ok) {
      console.error(`[sportsbookOdds] HTTP ${res.status} for ${sportKey}`);
      return [];
    }

    const events = (await res.json()) as OddsApiEvent[];
    if (!Array.isArray(events)) return [];

    const out: SportsbookEventConsensus[] = [];

    for (const event of events) {
      const homePm = countryNameToPm(event.home_team);
      const awayPm = countryNameToPm(event.away_team);
      if (!homePm || !awayPm || homePm === awayPm) continue;

      const consensus = consensusFromBookmakers(
        event,
        event.home_team,
        event.away_team
      );
      if (!consensus) continue;

      const date = event.commence_time.slice(0, 10);
      out.push({
        eventId: event.id,
        commenceTime: event.commence_time,
        date,
        homePm,
        awayPm,
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        ...consensus,
      });
    }

    return out;
  } catch (err) {
    console.error("[sportsbookOdds] fetch failed:", err);
    return [];
  }
}

export function sportsbookBookFromProb(
  prob: number,
  label: string,
  quoteUpdatedAt: number
): MarketBook {
  const mid = Math.round(prob * 1000) / 1000;
  const halfSpread = 0.005;
  const bid = Math.max(0.01, Math.round((mid - halfSpread) * 1000) / 1000);
  const ask = Math.min(0.99, Math.round((mid + halfSpread) * 1000) / 1000);
  return {
    bid,
    ask,
    mid,
    spread: ask - bid,
    quoteUpdatedAt,
    source: "sportsbook",
    label,
  };
}

async function resolvePmOrientedGame(
  homePm: string,
  awayPm: string,
  date: string,
  commenceTime: string
): Promise<{ game: ParsedGameKey; pmOutcomes: Awaited<ReturnType<typeof fetchPmGameMoneylines>> } | null> {
  const kickoffEpochSec = parseIsoSec(commenceTime);
  if (kickoffEpochSec == null) return null;

  const buildGame = (
    pmA: string,
    pmB: string,
    gameDate: string
  ): ParsedGameKey | null => {
    const kalshiA = pmCodeToKalshi(pmA);
    const kalshiB = pmCodeToKalshi(pmB);
    if (!kalshiA || !kalshiB) return null;
    return {
      date: gameDate,
      kalshiTeamA: kalshiA,
      kalshiTeamB: kalshiB,
      pmTeamA: pmA,
      pmTeamB: pmB,
      kickoffEpochSec,
      kickoffKnown: true,
    };
  };

  for (const tryDate of adjacentDates(date)) {
    for (const [pmA, pmB] of [
      [homePm, awayPm],
      [awayPm, homePm],
    ] as const) {
      for (const slugA of pmEventSlugCodeVariants(pmA)) {
        for (const slugB of pmEventSlugCodeVariants(pmB)) {
          const game = buildGame(slugA, slugB, tryDate);
          if (!game) continue;
          const pmOutcomes = await fetchPmGameMoneylines(game);
          if (pmOutcomes.size > 0) {
            return { game, pmOutcomes };
          }
        }
      }
    }
  }

  const game = buildGame(homePm, awayPm, date);
  if (!game) return null;
  return { game, pmOutcomes: new Map() };
}

function mapConsensusToOutcomes(
  game: ParsedGameKey,
  homePm: string,
  awayPm: string,
  consensus: SportsbookEventConsensus
): Map<OutcomeSide, number> {
  const probs = new Map<OutcomeSide, number>();

  const home = normalizePmTeamCode(homePm);
  const away = normalizePmTeamCode(awayPm);
  const teamA = normalizePmTeamCode(game.pmTeamA);
  const teamB = normalizePmTeamCode(game.pmTeamB);

  if (teamA === home && teamB === away) {
    probs.set("team_a", consensus.home);
    probs.set("team_b", consensus.away);
  } else if (teamA === away && teamB === home) {
    probs.set("team_a", consensus.away);
    probs.set("team_b", consensus.home);
  } else if (teamsMatchGame(game, homePm, awayPm)) {
    const homeOutcome = outcomeForWinner(game, homePm);
    const awayOutcome = outcomeForWinner(game, awayPm);
    if (homeOutcome) probs.set(homeOutcome, consensus.home);
    if (awayOutcome) probs.set(awayOutcome, consensus.away);
  } else {
    return probs;
  }

  if (consensus.draw > 0) {
    probs.set("draw", consensus.draw);
  }

  return probs;
}

function ensureIndexEntry(
  index: Map<string, OutcomeBooks>,
  game: ParsedGameKey,
  outcome: OutcomeSide,
  polymarket: MarketBook | null
): OutcomeBooks {
  const id = outcomeMatchId(game, outcome);
  let entry = index.get(id);
  if (!entry) {
    const label = `${game.pmTeamA.toUpperCase()} vs ${game.pmTeamB.toUpperCase()} (${game.date}) — ${outcome}`;
    entry = {
      game,
      outcome,
      kalshi: null,
      polymarket,
      manifold: null,
      sportsbook: null,
      label,
    };
    index.set(id, entry);
  } else if (polymarket && !entry.polymarket) {
    entry.polymarket = polymarket;
  }
  return entry;
}

/**
 * Attach sportsbook consensus books and expand index with PM games
 * that sportsbooks price but Kalshi/Manifold may not list.
 */
export async function attachSportsbookOddsToIndex(
  index: Map<string, OutcomeBooks>
): Promise<{ attached: number; events: number; newGames: number }> {
  const events = await fetchOddsApiWorldCupEvents();
  if (!events.length) {
    return { attached: 0, events: 0, newGames: 0 };
  }

  let attached = 0;
  let newGames = 0;

  for (const consensus of events) {
    let game = findGameInIndex(
      index,
      consensus.date,
      consensus.homePm,
      consensus.awayPm,
      { dateToleranceDays: 1 }
    );

    let pmOutcomes: Awaited<ReturnType<typeof fetchPmGameMoneylines>> | null =
      null;

    if (!game) {
      const resolved = await resolvePmOrientedGame(
        consensus.homePm,
        consensus.awayPm,
        consensus.date,
        consensus.commenceTime
      );
      if (!resolved) continue;
      game = resolved.game;
      pmOutcomes = resolved.pmOutcomes;
      newGames++;
    }

    const outcomeProbs = mapConsensusToOutcomes(
      game,
      consensus.homePm,
      consensus.awayPm,
      consensus
    );
    if (outcomeProbs.size === 0) continue;

    const label = `${consensus.homeTeam} vs ${consensus.awayTeam} (${consensus.date}) — sportsbook consensus (${consensus.bookmakerCount} books, no-vig)`;

    for (const [outcome, prob] of Array.from(outcomeProbs.entries())) {
      const pmBook = pmOutcomes?.get(outcome)?.book ?? null;
      const entry = ensureIndexEntry(index, game, outcome, pmBook);
      if (entry.sportsbook) continue;

      entry.sportsbook = sportsbookBookFromProb(
        prob,
        label,
        consensus.quoteUpdatedAt
      );
      attached++;
    }
  }

  return { attached, events: events.length, newGames };
}
