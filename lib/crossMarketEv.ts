import { kalshiCodeToPm, pmCodeToKalshi } from "@/lib/teamCodes";
import { mapWithConcurrency } from "@/lib/clvPriceHistory";
import {
  attachManifoldBooksToIndex,
  fetchManifoldSportsMarkets,
} from "@/lib/manifoldSports";
import {
  attachSportsbookOddsToIndex,
  isSportsbookOddsEnabled,
} from "@/lib/sportsbookOdds";
import {
  fetchKalshiGameMarkets,
  type KalshiMarket as KalshiRawMarket,
} from "@/lib/kalshi";

const GAMMA_API = "https://gamma-api.polymarket.com";

/** Game series with per-event priced contracts (add KXMLBGAME etc. later). */
export const KALSHI_GAME_SERIES = ["KXWCGAME"] as const;

export const LIVENESS_MAX_AGE_SEC = 60;
export const MAX_SPREAD = 0.05;

export type CrossMarketEvReason =
  | "no_match"
  | "fair_line_stale"
  | "in_play"
  | "missing_price"
  | "ok";

export type CrossMarketFairSource =
  | "kalshi"
  | "polymarket"
  | "manifold"
  | "sportsbook";

export interface CrossMarketEv {
  ev: number | null;
  fairProb: number | null;
  fairSource: CrossMarketFairSource | null;
  pricePaid: number | null;
  reason?: CrossMarketEvReason;
  matchedMarket?: string;
}

export type OutcomeSide = "team_a" | "team_b" | "draw";

export interface ParsedGameKey {
  date: string;
  kalshiTeamA: string;
  kalshiTeamB: string;
  pmTeamA: string;
  pmTeamB: string;
  kickoffEpochSec: number | null;
  kickoffKnown: boolean;
}

export interface MarketBook {
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread: number | null;
  quoteUpdatedAt: number | null;
  source: CrossMarketFairSource;
  label: string;
}

export interface OutcomeBooks {
  game: ParsedGameKey;
  outcome: OutcomeSide;
  kalshi: MarketBook | null;
  polymarket: MarketBook | null;
  manifold: MarketBook | null;
  sportsbook: MarketBook | null;
  label: string;
}

export interface BuildCrossMarketBookIndexOptions {
  kalshiRaw?: KalshiRawMarket[];
  /** When false, index contains Kalshi + Polymarket only (coverage baseline). */
  includeManifold?: boolean;
  /** When false, skip The Odds API sportsbook consensus. */
  includeSportsbook?: boolean;
}

interface GammaMarket {
  slug?: string;
  question?: string;
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  updatedAt?: string;
  gameStartTime?: string;
  endDate?: string;
  closed?: boolean;
}

const MONTH_MAP: Record<string, string> = {
  JAN: "01",
  FEB: "02",
  MAR: "03",
  APR: "04",
  MAY: "05",
  JUN: "06",
  JUL: "07",
  AUG: "08",
  SEP: "09",
  OCT: "10",
  NOV: "11",
  DEC: "12",
};

const PM_MONEYLINE_SLUG =
  /^fifwc-([a-z]+)-([a-z]+)-(\d{4}-\d{2}-\d{2})-([a-z]+)$/;

function parseNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function parseIsoSec(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function midpoint(bid: number | null, ask: number | null): number | null {
  if (bid == null || ask == null || bid <= 0 || ask <= 0) return null;
  return (bid + ask) / 2;
}

function spread(bid: number | null, ask: number | null): number | null {
  if (bid == null || ask == null) return null;
  return ask - bid;
}

/** Parse Kalshi game ticker middle token + outcome suffix. */
export function parseKalshiGameTicker(ticker: string): {
  series: string;
  game: ParsedGameKey;
  outcomeKalshi: string;
  outcome: OutcomeSide | null;
} | null {
  const parts = ticker.split("-").filter(Boolean);
  if (parts.length < 3) return null;

  const series = parts[0];
  const mid = parts[1];
  const outcomeKalshi = parts[2];

  const m = mid.match(
    /^(\d{2})([A-Z]{3})(\d{2})(?:(\d{4}))?([A-Z]{3})([A-Z]{3})$/
  );
  if (!m) return null;

  const [, yy, mon, dd, hhmm, teamA, teamB] = m;
  const month = MONTH_MAP[mon];
  if (!month) return null;

  const date = `20${yy}-${month}-${dd}`;
  const pmA = kalshiCodeToPm(teamA);
  const pmB = kalshiCodeToPm(teamB);
  if (!pmA || !pmB) return null;

  let kickoffEpochSec: number | null = null;
  let kickoffKnown = false;
  if (hhmm && hhmm.length === 4) {
    const hh = parseInt(hhmm.slice(0, 2), 10);
    const mm = parseInt(hhmm.slice(2, 4), 10);
    if (hh <= 23 && mm <= 59) {
      kickoffKnown = true;
      kickoffEpochSec = Math.floor(
        Date.UTC(parseInt(`20${yy}`, 10), parseInt(month, 10) - 1, parseInt(dd, 10), hh, mm) / 1000
      );
    }
  }

  const game: ParsedGameKey = {
    date,
    kalshiTeamA: teamA,
    kalshiTeamB: teamB,
    pmTeamA: pmA,
    pmTeamB: pmB,
    kickoffEpochSec,
    kickoffKnown,
  };

  let outcome: OutcomeSide | null = null;
  if (outcomeKalshi === "TIE") {
    outcome = "draw";
  } else if (outcomeKalshi === teamA) {
    outcome = "team_a";
  } else if (outcomeKalshi === teamB) {
    outcome = "team_b";
  }

  return { series, game, outcomeKalshi, outcome };
}

/** Parse PM fifwc moneyline slug (not totals/spreads). */
export function parsePmMoneylineSlug(slug: string): {
  game: ParsedGameKey;
  outcomePm: string;
  outcome: OutcomeSide | null;
} | null {
  if (
    slug.includes("total") ||
    slug.includes("spread") ||
    slug.includes("btts") ||
    slug.includes("halftime") ||
    slug.includes("first-half")
  ) {
    return null;
  }

  const m = slug.match(PM_MONEYLINE_SLUG);
  if (!m) return null;

  const [, pmA, pmB, date, outcomePm] = m;
  const kalshiA = pmCodeToKalshi(pmA);
  const kalshiB = pmCodeToKalshi(pmB);
  if (!kalshiA || !kalshiB) return null;

  const game: ParsedGameKey = {
    date,
    kalshiTeamA: kalshiA,
    kalshiTeamB: kalshiB,
    pmTeamA: pmA,
    pmTeamB: pmB,
    kickoffEpochSec: null,
    kickoffKnown: false,
  };

  let outcome: OutcomeSide | null = null;
  if (outcomePm === "draw") {
    outcome = "draw";
  } else if (outcomePm === pmA) {
    outcome = "team_a";
  } else if (outcomePm === pmB) {
    outcome = "team_b";
  }

  return { game, outcomePm, outcome };
}

export function gameMatchId(game: ParsedGameKey): string {
  return `${game.date}|${game.kalshiTeamA}|${game.kalshiTeamB}`;
}

export function outcomeMatchId(
  game: ParsedGameKey,
  outcome: OutcomeSide
): string {
  return `${gameMatchId(game)}|${outcome}`;
}

export function pmEventSlug(game: ParsedGameKey): string {
  return `fifwc-${game.pmTeamA}-${game.pmTeamB}-${game.date}`;
}

function kalshiBookFromRaw(m: KalshiRawMarket): MarketBook {
  const bid = parseNum(m.yes_bid_dollars);
  const ask = parseNum(m.yes_ask_dollars);
  return {
    bid,
    ask,
    mid: midpoint(bid, ask),
    spread: spread(bid, ask),
    quoteUpdatedAt: parseIsoSec(m.updated_time),
    source: "kalshi",
    label: m.ticker ?? m.title ?? "Kalshi",
  };
}

function pmBookFromRaw(m: GammaMarket): MarketBook {
  const bid = parseNum(m.bestBid);
  const ask = parseNum(m.bestAsk);
  return {
    bid,
    ask,
    mid: midpoint(bid, ask),
    spread: spread(bid, ask),
    quoteUpdatedAt: parseIsoSec(m.updatedAt),
    source: "polymarket",
    label: m.question ?? m.slug ?? "Polymarket",
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "MarketPulse/1.0" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json() as Promise<T>;
}

/** Fetch PM moneyline books for a single game event (3 outcomes). */
export async function fetchPmGameMoneylines(
  game: ParsedGameKey
): Promise<Map<OutcomeSide, { book: MarketBook; kickoffEpochSec: number | null }>> {
  const slug = pmEventSlug(game);
  const events = await fetchJson<
    Array<{ markets?: GammaMarket[]; startTime?: string }>
  >(`${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`);

  const out = new Map<
    OutcomeSide,
    { book: MarketBook; kickoffEpochSec: number | null }
  >();
  if (!events?.length) return out;

  const event = events[0];
  let kickoff = parseIsoSec(event.startTime ?? null);

  for (const m of event.markets ?? []) {
    const parsed = parsePmMoneylineSlug(m.slug ?? "");
    if (!parsed || parsed.outcome == null) continue;
    if (gameMatchId(parsed.game) !== gameMatchId(game)) continue;

    const gs = parseIsoSec(m.gameStartTime ?? m.endDate ?? null);
    if (gs) kickoff = gs;

    out.set(parsed.outcome, {
      book: pmBookFromRaw(m),
      kickoffEpochSec: gs ?? kickoff,
    });
  }

  return out;
}

/** Build matched outcome books from Kalshi + PM (+ optional Manifold). */
export async function buildCrossMarketBookIndex(
  optionsOrKalshi?: BuildCrossMarketBookIndexOptions | KalshiRawMarket[]
): Promise<Map<string, OutcomeBooks>> {
  const options: BuildCrossMarketBookIndexOptions = Array.isArray(optionsOrKalshi)
    ? { kalshiRaw: optionsOrKalshi }
    : (optionsOrKalshi ?? {});
  const includeManifold = options.includeManifold !== false;
  const includeSportsbook =
    options.includeSportsbook !== false && isSportsbookOddsEnabled();
  const raw =
    options.kalshiRaw ?? (await fetchKalshiGameMarkets(KALSHI_GAME_SERIES));
  const kalshiByOutcome = new Map<string, MarketBook>();
  const games = new Map<string, ParsedGameKey>();

  for (const m of raw) {
    const ticker = m.ticker;
    if (!ticker) continue;
    const parsed = parseKalshiGameTicker(ticker);
    if (!parsed || parsed.outcome == null) continue;

    const gid = gameMatchId(parsed.game);
    games.set(gid, parsed.game);
    kalshiByOutcome.set(
      outcomeMatchId(parsed.game, parsed.outcome),
      kalshiBookFromRaw(m)
    );
  }

  const index = new Map<string, OutcomeBooks>();
  const gameList = Array.from(games.values());

  const pmByGame = await mapWithConcurrency(gameList, 8, async (game) => ({
    game,
    pmOutcomes: await fetchPmGameMoneylines(game),
  }));

  for (const { game, pmOutcomes } of pmByGame) {
    if (pmOutcomes.size > 0) {
      const first = pmOutcomes.values().next().value;
      if (first?.kickoffEpochSec && !game.kickoffKnown) {
        game.kickoffEpochSec = first.kickoffEpochSec;
        game.kickoffKnown = true;
      }
    }

    for (const outcome of ["team_a", "team_b", "draw"] as OutcomeSide[]) {
      const id = outcomeMatchId(game, outcome);
      const kalshi = kalshiByOutcome.get(id) ?? null;
      const pmEntry = pmOutcomes.get(outcome);
      const polymarket = pmEntry?.book ?? null;

      if (!kalshi && !polymarket) continue;

      const label = `${game.pmTeamA.toUpperCase()} vs ${game.pmTeamB.toUpperCase()} (${game.date}) — ${outcome}`;
      index.set(id, {
        game,
        outcome,
        kalshi,
        polymarket,
        manifold: null,
        sportsbook: null,
        label,
      });
    }
  }

  if (includeManifold) {
    const manifoldMarkets = await fetchManifoldSportsMarkets();
    attachManifoldBooksToIndex(index, manifoldMarkets);
  }

  if (includeSportsbook) {
    await attachSportsbookOddsToIndex(index);
  }

  return index;
}

function isBookQuotable(book: MarketBook | null): book is MarketBook {
  return book != null && book.mid != null && book.bid != null && book.ask != null;
}

function isBookFresh(book: MarketBook, nowSec: number): boolean {
  if (book.bid == null || book.ask == null) return false;
  const sp = book.spread ?? spread(book.bid, book.ask);
  if (sp == null || sp > MAX_SPREAD) return false;
  if (book.quoteUpdatedAt == null) return false;
  return nowSec - book.quoteUpdatedAt <= LIVENESS_MAX_AGE_SEC;
}

function dateOnlyStartSec(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 1000);
}

function isPreKickoff(game: ParsedGameKey, nowSec: number): boolean {
  if (game.kickoffKnown && game.kickoffEpochSec != null) {
    return nowSec < game.kickoffEpochSec;
  }
  const today = new Date(nowSec * 1000).toISOString().slice(0, 10);
  if (game.date > today) return true;
  return false;
}

function isPotentiallyInPlay(game: ParsedGameKey, nowSec: number): boolean {
  if (game.kickoffKnown && game.kickoffEpochSec != null) {
    return nowSec >= game.kickoffEpochSec;
  }
  const today = new Date(nowSec * 1000).toISOString().slice(0, 10);
  if (game.date < today) return true;
  if (game.date === today) return true;
  return false;
}

export interface LivenessResult {
  ok: boolean;
  reason: CrossMarketEvReason;
}

/** Liveness guard — fail closed when fair line is not trustworthy. */
export function checkLiveness(
  fairBook: MarketBook,
  ownBook: MarketBook | null,
  game: ParsedGameKey,
  nowSec: number = Math.floor(Date.now() / 1000)
): LivenessResult {
  if (!isBookQuotable(fairBook)) {
    return { ok: false, reason: "fair_line_stale" };
  }

  if (isPreKickoff(game, nowSec)) {
    const sp = fairBook.spread ?? spread(fairBook.bid, fairBook.ask);
    if (sp != null && sp <= MAX_SPREAD) {
      return { ok: true, reason: "ok" };
    }
    return { ok: false, reason: "fair_line_stale" };
  }

  if (isPotentiallyInPlay(game, nowSec)) {
    const fairFresh = isBookFresh(fairBook, nowSec);
    const ownFresh = ownBook ? isBookFresh(ownBook, nowSec) : false;

    if (!fairFresh || !ownFresh) {
      return { ok: false, reason: "in_play" };
    }

    if (ownBook && isBookQuotable(ownBook)) {
      const divergence = Math.abs((ownBook.mid ?? 0) - (fairBook.mid ?? 0));
      if (divergence > MAX_SPREAD * 2) {
        return { ok: false, reason: "in_play" };
      }
    }

    return { ok: true, reason: "ok" };
  }

  if (dateOnlyStartSec(game.date) > nowSec) {
    return { ok: true, reason: "ok" };
  }

  return { ok: false, reason: "fair_line_stale" };
}

export function computeEvPercent(
  pricePaid: number,
  fairProb: number
): number | null {
  if (pricePaid <= 0 || !Number.isFinite(pricePaid)) return null;
  return ((fairProb - pricePaid) / pricePaid) * 100;
}

function isManifoldQuotable(book: MarketBook | null): book is MarketBook {
  return (
    book != null &&
    book.mid != null &&
    book.mid > 0 &&
    book.mid < 1 &&
    book.bid != null &&
    book.ask != null
  );
}

function isSportsbookQuotable(book: MarketBook | null): book is MarketBook {
  return isManifoldQuotable(book);
}

function isFairBookQuotable(
  source: CrossMarketFairSource,
  book: MarketBook | null
): book is MarketBook {
  if (source === "manifold" || source === "sportsbook") {
    return isSportsbookQuotable(book);
  }
  return isBookQuotable(book);
}

function selectFairReference(
  tradeSource: "polymarket" | "kalshi",
  kalshiBook: MarketBook | null,
  polymarketBook: MarketBook | null,
  manifoldBook: MarketBook | null,
  sportsbookBook: MarketBook | null,
  ownBook: MarketBook | null,
  game: ParsedGameKey,
  nowSec: number
):
  | { fairSource: CrossMarketFairSource; fairBook: MarketBook }
  | { reason: CrossMarketEvReason } {
  const candidates: {
    source: CrossMarketFairSource;
    book: MarketBook | null;
  }[] =
    tradeSource === "polymarket"
      ? [
          { source: "kalshi", book: kalshiBook },
          { source: "manifold", book: manifoldBook },
          { source: "sportsbook", book: sportsbookBook },
        ]
      : [
          { source: "polymarket", book: polymarketBook },
          { source: "manifold", book: manifoldBook },
          { source: "sportsbook", book: sportsbookBook },
        ];

  let lastReason: CrossMarketEvReason = "no_match";

  for (const { source, book } of candidates) {
    if (!book) continue;
    if (!isFairBookQuotable(source, book)) {
      lastReason = "fair_line_stale";
      continue;
    }
    const liveness = checkLiveness(book, ownBook, game, nowSec);
    if (!liveness.ok) {
      lastReason = liveness.reason;
      continue;
    }
    return { fairSource: source, fairBook: book };
  }

  return { reason: lastReason };
}

export interface ComputeCrossMarketEvInput {
  tradeSource: "polymarket" | "kalshi";
  /** Actual trade price, or owning market mid when pricing a book row. */
  pricePaid: number | null;
  game: ParsedGameKey;
  outcome: OutcomeSide;
  kalshiBook: MarketBook | null;
  polymarketBook: MarketBook | null;
  manifoldBook?: MarketBook | null;
  sportsbookBook?: MarketBook | null;
  nowSec?: number;
}

function resolvePricePaid(
  tradeSource: "polymarket" | "kalshi",
  pricePaid: number | null,
  pmMid: number | null,
  kalshiMid: number | null
): number | null {
  if (pricePaid != null && Number.isFinite(pricePaid) && pricePaid > 0) {
    return pricePaid;
  }
  return tradeSource === "polymarket" ? pmMid : kalshiMid;
}

export function computeCrossMarketEv(
  input: ComputeCrossMarketEvInput
): CrossMarketEv {
  const {
    tradeSource,
    pricePaid,
    game,
    kalshiBook,
    polymarketBook,
    manifoldBook = null,
    sportsbookBook = null,
    nowSec = Math.floor(Date.now() / 1000),
  } = input;

  const ownBook =
    tradeSource === "polymarket" ? polymarketBook : kalshiBook;

  const matchedMarket = `${game.pmTeamA.toUpperCase()} vs ${game.pmTeamB.toUpperCase()} (${game.date})`;

  const pmMid = polymarketBook?.mid ?? null;
  const kalshiMid = kalshiBook?.mid ?? null;
  const effectivePricePaid = resolvePricePaid(
    tradeSource,
    pricePaid,
    pmMid,
    kalshiMid
  );

  if (effectivePricePaid == null || effectivePricePaid <= 0) {
    return {
      ev: null,
      fairProb: null,
      fairSource: null,
      pricePaid: effectivePricePaid,
      reason: "missing_price",
      matchedMarket,
    };
  }

  const fairPick = selectFairReference(
    tradeSource,
    kalshiBook,
    polymarketBook,
    manifoldBook,
    sportsbookBook,
    ownBook,
    game,
    nowSec
  );

  if ("reason" in fairPick) {
    return {
      ev: null,
      fairProb: null,
      fairSource: null,
      pricePaid: effectivePricePaid,
      reason: fairPick.reason,
      matchedMarket,
    };
  }

  const { fairSource, fairBook } = fairPick;
  const fairProb = fairBook.mid;
  if (fairProb == null) {
    return {
      ev: null,
      fairProb: null,
      fairSource: null,
      pricePaid: effectivePricePaid,
      reason: "missing_price",
      matchedMarket,
    };
  }

  const evRaw = computeEvPercent(effectivePricePaid, fairProb);

  return {
    ev: evRaw != null ? Math.round(evRaw * 10) / 10 : null,
    fairProb: Math.round(fairProb * 100) / 100,
    fairSource,
    pricePaid: Math.round(effectivePricePaid * 100) / 100,
    reason: "ok",
    matchedMarket,
  };
}

/** Resolve EV for a trade using a pre-built book index. */
export function computeCrossMarketEvFromIndex(
  index: Map<string, OutcomeBooks>,
  tradeSource: "polymarket" | "kalshi",
  pricePaid: number | null,
  game: ParsedGameKey,
  outcome: OutcomeSide,
  nowSec?: number
): CrossMarketEv {
  const entry = index.get(outcomeMatchId(game, outcome));
  if (!entry) {
    return {
      ev: null,
      fairProb: null,
      fairSource: null,
      pricePaid,
      reason: "no_match",
    };
  }

  return computeCrossMarketEv({
    tradeSource,
    pricePaid,
    game: entry.game,
    outcome,
    kalshiBook: entry.kalshi,
    polymarketBook: entry.polymarket,
    manifoldBook: entry.manifold,
    sportsbookBook: entry.sportsbook,
    nowSec,
  });
}

export interface GameEvSnapshot {
  game: ParsedGameKey;
  outcome: OutcomeSide;
  label: string;
  pmMid: number | null;
  kalshiMid: number | null;
  gap: number | null;
  evIfBuyOnPm: CrossMarketEv;
  evIfBuyOnKalshi: CrossMarketEv;
  preKickoff: boolean;
  potentiallyInPlay: boolean;
}

/** Snapshot both sides for verification / debugging. */
export function snapshotGameEv(
  entry: OutcomeBooks,
  nowSec: number = Math.floor(Date.now() / 1000)
): GameEvSnapshot {
  const pmMid = entry.polymarket?.mid ?? null;
  const kalshiMid = entry.kalshi?.mid ?? null;
  const gap =
    pmMid != null && kalshiMid != null
      ? Math.abs(pmMid - kalshiMid)
      : null;

  return {
    game: entry.game,
    outcome: entry.outcome,
    label: entry.label,
    pmMid,
    kalshiMid,
    gap,
    evIfBuyOnPm: computeCrossMarketEv({
      tradeSource: "polymarket",
      pricePaid: pmMid,
      game: entry.game,
      outcome: entry.outcome,
      kalshiBook: entry.kalshi,
      polymarketBook: entry.polymarket,
      manifoldBook: entry.manifold,
      sportsbookBook: entry.sportsbook,
      nowSec,
    }),
    evIfBuyOnKalshi: computeCrossMarketEv({
      tradeSource: "kalshi",
      pricePaid: kalshiMid,
      game: entry.game,
      outcome: entry.outcome,
      kalshiBook: entry.kalshi,
      polymarketBook: entry.polymarket,
      manifoldBook: entry.manifold,
      sportsbookBook: entry.sportsbook,
      nowSec,
    }),
    preKickoff: isPreKickoff(entry.game, nowSec),
    potentiallyInPlay: isPotentiallyInPlay(entry.game, nowSec),
  };
}
