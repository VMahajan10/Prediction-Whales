import { NextResponse } from "next/server";
import {
  computeCrossMarketEv,
  gameMatchId,
  type CrossMarketEvReason,
  type MarketBook,
  type OutcomeBooks,
} from "@/lib/crossMarketEv";
import {
  entriesToMap,
  getCrossMarketEvIndex,
} from "@/lib/crossMarketEvIndexStore";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface MatchRow {
  matchedMarket: string;
  pricePaid: number | null;
  fairProb: number | null;
  ev: number | null;
  reason: CrossMarketEvReason;
  guardSuppressed: boolean;
  phase: "pre_match" | "in_play" | "unknown";
  pmMid: number | null;
  kalshiMid: number | null;
  synthetic?: boolean;
  syntheticNote?: string;
}

function isGuardSuppressed(reason: CrossMarketEvReason): boolean {
  return (
    reason === "in_play" ||
    reason === "fair_line_stale" ||
    reason === "missing_price"
  );
}

function rowFromEv(
  result: ReturnType<typeof computeCrossMarketEv>,
  entry: OutcomeBooks,
  phase: MatchRow["phase"],
  extra?: Pick<MatchRow, "synthetic" | "syntheticNote">
): MatchRow {
  const reason = result.reason ?? "no_match";
  return {
    matchedMarket: result.matchedMarket ?? entry.label,
    pricePaid: result.pricePaid,
    fairProb: result.fairProb,
    ev: result.ev,
    reason,
    guardSuppressed: isGuardSuppressed(reason),
    phase,
    pmMid: entry.polymarket?.mid ?? null,
    kalshiMid: entry.kalshi?.mid ?? null,
    ...extra,
  };
}

function phaseForEntry(
  entry: OutcomeBooks,
  nowSec: number
): MatchRow["phase"] {
  const { game } = entry;
  if (game.kickoffKnown && game.kickoffEpochSec != null) {
    return nowSec < game.kickoffEpochSec ? "pre_match" : "in_play";
  }
  const today = new Date(nowSec * 1000).toISOString().slice(0, 10);
  if (game.date > today) return "pre_match";
  if (game.date < today) return "in_play";
  return "in_play";
}

function staleKalshiBook(book: MarketBook, nowSec: number): MarketBook {
  return {
    ...book,
    quoteUpdatedAt: nowSec - 3600,
  };
}

function wideSpreadKalshiBook(book: MarketBook): MarketBook {
  const bid = book.bid ?? 0.4;
  return {
    ...book,
    bid,
    ask: bid + 0.12,
    mid: bid + 0.06,
    spread: 0.12,
    quoteUpdatedAt: Math.floor(Date.now() / 1000),
  };
}

function inPlayGame(entry: OutcomeBooks) {
  const kickoff = Math.floor(Date.now() / 1000) - 1800;
  return {
    ...entry.game,
    kickoffEpochSec: kickoff,
    kickoffKnown: true,
  };
}

function buildSyntheticStaleInPlay(
  entry: OutcomeBooks,
  nowSec: number
): MatchRow {
  const game = inPlayGame(entry);
  const pmMid = entry.polymarket?.mid ?? null;
  const staleKalshi = entry.kalshi
    ? staleKalshiBook(entry.kalshi, nowSec)
    : null;

  const result = computeCrossMarketEv({
    tradeSource: "polymarket",
    pricePaid: pmMid,
    game,
    outcome: entry.outcome,
    kalshiBook: staleKalshi,
    polymarketBook: entry.polymarket,
    manifoldBook: entry.manifold,
    sportsbookBook: entry.sportsbook,
    nowSec,
  });

  return rowFromEv(result, entry, "in_play", {
    synthetic: true,
    syntheticNote:
      "Simulated in-play + Kalshi fair line timestamp 1h stale (real matched game)",
  });
}

function buildSyntheticWideSpreadPreMatch(
  entry: OutcomeBooks,
  nowSec: number
): MatchRow {
  const pmMid = entry.polymarket?.mid ?? null;
  const wideKalshi = entry.kalshi
    ? wideSpreadKalshiBook(entry.kalshi)
    : null;

  const result = computeCrossMarketEv({
    tradeSource: "polymarket",
    pricePaid: pmMid,
    game: entry.game,
    outcome: entry.outcome,
    kalshiBook: wideKalshi,
    polymarketBook: entry.polymarket,
    manifoldBook: entry.manifold,
    sportsbookBook: entry.sportsbook,
    nowSec,
  });

  return rowFromEv(result, entry, "pre_match", {
    synthetic: true,
    syntheticNote:
      "Simulated pre-match + Kalshi fair line 12¢ spread (>5¢ max)",
  });
}

function summarize(matches: MatchRow[]) {
  return {
    total: matches.length,
    evShown: matches.filter((m) => m.ev != null && m.reason === "ok").length,
    suppressedInPlay: matches.filter((m) => m.reason === "in_play").length,
    suppressedStale: matches.filter((m) => m.reason === "fair_line_stale")
      .length,
    suppressedMissingPrice: matches.filter((m) => m.reason === "missing_price")
      .length,
    noMatch: matches.filter((m) => m.reason === "no_match").length,
  };
}

export async function GET() {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = await getCrossMarketEvIndex();
    const index = entriesToMap(payload.entries);

    const byGame = new Map<string, OutcomeBooks>();
    for (const entry of Array.from(index.values())) {
      if (entry.outcome !== "team_a") continue;
      const gid = gameMatchId(entry.game);
      if (!byGame.has(gid)) byGame.set(gid, entry);
    }

    const liveMatches: MatchRow[] = [];
    for (const entry of Array.from(byGame.values())) {
      const phase = phaseForEntry(entry, nowSec);
      const pmMid = entry.polymarket?.mid ?? null;

      const result = computeCrossMarketEv({
        tradeSource: "polymarket",
        pricePaid: pmMid,
        game: entry.game,
        outcome: entry.outcome,
        kalshiBook: entry.kalshi,
        polymarketBook: entry.polymarket,
        manifoldBook: entry.manifold,
        nowSec,
      });

      liveMatches.push(rowFromEv(result, entry, phase));
    }

    liveMatches.sort((a, b) => a.matchedMarket.localeCompare(b.matchedMarket));

    const liveSummary = summarize(liveMatches);
    const hasLiveEv = liveSummary.evShown > 0;
    const hasLiveGuardProof =
      liveSummary.suppressedInPlay > 0 || liveSummary.suppressedStale > 0;

    const synthetic: MatchRow[] = [];
    const proofBase =
      Array.from(byGame.values()).find(
        (e) => e.kalshi?.mid != null && e.polymarket?.mid != null
      ) ?? Array.from(byGame.values())[0];

    if (proofBase) {
      if (!hasLiveGuardProof) {
        synthetic.push(buildSyntheticStaleInPlay(proofBase, nowSec));
        synthetic.push(buildSyntheticWideSpreadPreMatch(proofBase, nowSec));
      } else if (!hasLiveEv) {
        synthetic.push(buildSyntheticWideSpreadPreMatch(proofBase, nowSec));
      }
    }

    const matches = [...liveMatches, ...synthetic];
    const summary = summarize(matches);

    const checkpoint = {
      preMatchWithEv: matches.find(
        (m) => !m.synthetic && m.reason === "ok" && m.ev != null
      ),
      guardSuppressed: matches.find(
        (m) => m.guardSuppressed && (m.reason === "in_play" || m.reason === "fair_line_stale")
      ),
    };

    return NextResponse.json({
      generatedAt: new Date(nowSec * 1000).toISOString(),
      matches,
      synthetic,
      checkpoint,
      summary,
    });
  } catch (err) {
    console.error("[cross-market-ev]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
