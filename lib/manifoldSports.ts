import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import {
  gameMatchId,
  outcomeMatchId,
  type MarketBook,
  type OutcomeBooks,
  type OutcomeSide,
  type ParsedGameKey,
} from "@/lib/crossMarketEv";
import {
  countryNameToPm,
  outcomeForWinner,
  teamsMatchGame,
} from "@/lib/sportsTeamMatch";

const MANIFOLD_API = "https://api.manifold.markets";
/** Per-page request cap; overall fetch is bounded by MANIFOLD_SPORTS_TIMEOUT_MS. */
const FETCH_TIMEOUT_MS = 5000;
export const MANIFOLD_SPORTS_TIMEOUT_MS = 5000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

export interface ManifoldSportsMarket {
  id: string;
  title: string;
  yesPrice: number;
  volume: number;
}

export interface ManifoldDefeatParse {
  winnerPm: string;
  loserPm: string;
}

/**
 * Parse unambiguous Manifold WC moneyline titles:
 * "Will Portugal defeat Colombia in their first match in the 2026 World Cup?"
 */
export function parseManifoldDefeatMarket(
  title: string
): ManifoldDefeatParse | null {
  const t = title.trim();
  if (!/world cup|fifa/i.test(t)) return null;
  if (/prop|goal|score|draw|group [a-z]|final|cr7|messi|ronaldo|hat trick/i.test(t)) {
    return null;
  }

  const defeat =
    /^will (.+?) defeat (.+?)(?:\s+in|\s+at|\?|$)/i.exec(t) ??
    /^will (.+?) beat (.+?)(?:\s+in|\s+at|\?|$)/i.exec(t);

  if (!defeat) return null;

  const winnerPm = countryNameToPm(defeat[1]);
  const loserPm = countryNameToPm(defeat[2]);
  if (!winnerPm || !loserPm || winnerPm === loserPm) return null;

  return { winnerPm, loserPm };
}

export function manifoldBookFromPrice(
  title: string,
  yesPrice: number,
  nowSec: number
): MarketBook {
  const mid = Math.round(yesPrice * 1000) / 1000;
  const halfSpread = 0.005;
  const bid = Math.max(0.01, Math.round((mid - halfSpread) * 1000) / 1000);
  const ask = Math.min(0.99, Math.round((mid + halfSpread) * 1000) / 1000);
  return {
    bid,
    ask,
    mid,
    spread: ask - bid,
    quoteUpdatedAt: nowSec,
    source: "manifold",
    label: title,
  };
}

interface ManifoldMarketApi {
  id: string;
  question: string;
  probability?: number;
  p?: number;
  volume?: number;
  outcomeType?: string;
  isResolved?: boolean;
}

function manifoldYesPrice(m: ManifoldMarketApi): number | null {
  if (m.outcomeType !== "BINARY") return null;
  if (m.isResolved === true) return null;
  const prob = m.probability;
  if (typeof prob !== "number" || !Number.isFinite(prob)) return null;
  if (
    prob === 0.5 &&
    (m.volume ?? 0) === 0 &&
    typeof m.p === "number" &&
    m.p === 0.5
  ) {
    return null;
  }
  if (prob <= 0 || prob >= 1) return null;
  return prob;
}

async function fetchManifoldSportsMarketsInner(
  outerSignal?: AbortSignal
): Promise<ManifoldSportsMarket[]> {
  const out: ManifoldSportsMarket[] = [];
  let before: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (outerSignal?.aborted) break;

    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (before) params.set("before", before);

    const res = await fetchWithTimeout(`${MANIFOLD_API}/v0/markets?${params}`, {
      headers: { Accept: "application/json" },
      timeoutMs: FETCH_TIMEOUT_MS,
      signal: outerSignal,
    });
    if (!res.ok) break;

    const markets = (await res.json()) as ManifoldMarketApi[];
    if (!Array.isArray(markets) || markets.length === 0) break;

    for (const m of markets) {
      if (m.isResolved || !m.id || !m.question) continue;
      const yesPrice = manifoldYesPrice(m);
      if (yesPrice == null) continue;
      out.push({
        id: m.id,
        title: m.question,
        yesPrice,
        volume: m.volume ?? 0,
      });
    }

    if (markets.length < PAGE_LIMIT) break;
    before = markets[markets.length - 1]?.id;
    if (!before) break;
  }

  return out;
}

/** Open Manifold binary markets (no API key). Fails fast with [] on timeout. */
export async function fetchManifoldSportsMarkets(): Promise<
  ManifoldSportsMarket[]
> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    MANIFOLD_SPORTS_TIMEOUT_MS
  );

  try {
    return await fetchManifoldSportsMarketsInner(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      console.warn(
        `[manifoldSports] fetch timed out after ${MANIFOLD_SPORTS_TIMEOUT_MS}ms — returning []`
      );
    } else {
      console.error("[manifoldSports] fetch failed:", err);
    }
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Attach Manifold books to an existing cross-market index.
 * Only clean defeat-pattern matches on a unique indexed game.
 */
export function attachManifoldBooksToIndex(
  index: Map<string, OutcomeBooks>,
  manifoldMarkets: ManifoldSportsMarket[],
  nowSec: number = Math.floor(Date.now() / 1000)
): void {
  for (const m of manifoldMarkets) {
    const parsed = parseManifoldDefeatMarket(m.title);
    if (!parsed) continue;

    const matchingGames = new Map<string, ParsedGameKey>();
    for (const entry of Array.from(index.values())) {
      if (teamsMatchGame(entry.game, parsed.winnerPm, parsed.loserPm)) {
        matchingGames.set(gameMatchId(entry.game), entry.game);
      }
    }
    if (matchingGames.size !== 1) continue;

    const game = matchingGames.values().next().value as ParsedGameKey;
    const outcome = outcomeForWinner(game, parsed.winnerPm);
    if (!outcome) continue;

    const id = outcomeMatchId(game, outcome);
    const entry = index.get(id);
    if (!entry) continue;
    if (entry.manifold) continue;

    entry.manifold = manifoldBookFromPrice(m.title, m.yesPrice, nowSec);
  }
}
