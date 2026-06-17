"use client";

import { useMemo } from "react";
import type { FeedTrade } from "@/lib/kalshiTrades";
import { usePolymarketSocketContext } from "@/lib/PolymarketSocketProvider";
import type { SocketTrade } from "@/lib/usePolymarketSocket";
import { useKalshiTrades } from "@/lib/useKalshiTrades";

const MAX_TRADES = 50;
const KALSHI_SLOTS = 20;
const PM_SLOTS = 30;

function byTimeDesc(a: FeedTrade, b: FeedTrade): number {
  return b.timestamp - a.timestamp;
}

function mergeWithReservedSlots(
  pm: FeedTrade[],
  kalshi: FeedTrade[]
): FeedTrade[] {
  const pmSorted = [...pm].sort(byTimeDesc);
  const kalshiSorted = [...kalshi].sort(byTimeDesc);

  const kalshiTake = kalshiSorted.slice(0, KALSHI_SLOTS);
  const pmTake = pmSorted.slice(0, PM_SLOTS);

  const kalshiShort = KALSHI_SLOTS - kalshiTake.length;
  const pmShort = PM_SLOTS - pmTake.length;

  const pmFinal = pmSorted.slice(0, PM_SLOTS + kalshiShort);
  const kalshiFinal = kalshiSorted.slice(0, KALSHI_SLOTS + pmShort);

  return interleave(pmFinal, kalshiFinal);
}

function interleave(pm: FeedTrade[], kalshi: FeedTrade[]): FeedTrade[] {
  const result: FeedTrade[] = [];
  let pi = 0;
  let ki = 0;
  let pos = 0;

  while (
    result.length < MAX_TRADES &&
    (pi < pm.length || ki < kalshi.length)
  ) {
    const wantKalshi = pos % 3 === 2;
    if (wantKalshi && ki < kalshi.length) {
      result.push(kalshi[ki++]);
    } else if (pi < pm.length) {
      result.push(pm[pi++]);
    } else if (ki < kalshi.length) {
      result.push(kalshi[ki++]);
    }
    pos++;
  }

  return result;
}

function adaptPolymarketTrade(t: SocketTrade): FeedTrade {
  return {
    id: t.id,
    source: "polymarket",
    title: t.title,
    outcome: t.outcome,
    side: t.side,
    price: t.price,
    size: t.size,
    usdNotional: t.usdNotional,
    timestamp: t.timestamp,
    traceable: true,
    transactionHash: t.transactionHash,
  };
}

export function useLiveFeed() {
  const { trades: pmTrades, connected: polymarketConnected } =
    usePolymarketSocketContext();
  const { trades: kalshiTrades, ok: kalshiOk } = useKalshiTrades();

  const trades = useMemo(() => {
    const pmMap = new Map<string, FeedTrade>();
    const kalshiMap = new Map<string, FeedTrade>();

    for (const t of pmTrades) {
      const feed = adaptPolymarketTrade(t);
      pmMap.set(feed.id, feed);
    }

    for (const t of kalshiTrades) {
      kalshiMap.set(t.id, t);
    }

    return mergeWithReservedSlots(
      Array.from(pmMap.values()),
      Array.from(kalshiMap.values())
    );
  }, [pmTrades, kalshiTrades]);

  return { trades, polymarketConnected, kalshiOk };
}
