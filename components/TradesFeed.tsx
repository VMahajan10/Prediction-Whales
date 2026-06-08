"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { getTimeAgo } from "@/lib/time";
import {
  usePolymarketSocket,
  type SocketTrade,
} from "@/lib/usePolymarketSocket";

export default function TradesFeed() {
  const { trades: socketTrades, connected } = usePolymarketSocket(50);

  const [polledTrades, setPolledTrades] = useState<SocketTrade[]>([]);
  const [newTradeIds, setNewTradeIds] = useState<Set<string>>(new Set());
  const prevLatestId = useRef<string | null>(null);

  useEffect(() => {
    const fetchTrades = async () => {
      try {
        const res = await fetch("/api/trades");
        const data: { trades?: SocketTrade[] } = await res.json();
        setPolledTrades(data.trades ?? []);
      } catch {
        // Keep existing polled trades on failure
      }
    };

    fetchTrades();
    const interval = setInterval(fetchTrades, 10000);
    return () => clearInterval(interval);
  }, []);

  const trades = socketTrades.length > 0 ? socketTrades : polledTrades;
  const whales = trades.filter((t) => t.size >= 500);

  useEffect(() => {
    if (!connected || socketTrades.length === 0) return;

    const latestId = socketTrades[0].id;
    if (latestId === prevLatestId.current) return;
    prevLatestId.current = latestId;

    setNewTradeIds((prev) => {
      const next = new Set(prev);
      next.add(latestId);
      return next;
    });
    const timer = setTimeout(() => {
      setNewTradeIds((prev) => {
        const next = new Set(prev);
        next.delete(latestId);
        return next;
      });
    }, 2000);

    return () => clearTimeout(timer);
  }, [connected, socketTrades]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Live Trades</h2>
        <div className="flex items-center gap-2">
          {connected ? (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
              </span>
              Live
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-slate-400">
              <span className="h-2 w-2 rounded-full bg-slate-500" />
              Polling
            </span>
          )}
        </div>
      </div>

      <div className="mb-2 text-xs text-slate-500">
        {trades.length} recent trades · {whales.length} whale
        {whales.length !== 1 ? "s" : ""}
      </div>

      <div className="max-h-[480px] flex-1 space-y-1 overflow-y-auto">
        {trades.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-500">
            {connected ? "Waiting for trades..." : "Loading trades..."}
          </div>
        ) : (
          trades.map((trade, index) => (
            <Link
              key={trade.id || trade.transactionHash || index}
              href={`/trades/${encodeURIComponent(trade.transactionHash)}`}
              className={`block cursor-pointer rounded-lg border border-transparent p-2 transition-colors hover:border-slate-600 hover:bg-slate-700 ${
                trade.size >= 500 ? "border-l-2 border-l-yellow-500" : ""
              } ${newTradeIds.has(trade.id) ? "animate-trade-in" : ""}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-200">
                    {trade.title}
                  </p>
                  <p className="text-xs text-slate-400">
                    {trade.outcome} @ {(trade.price * 100).toFixed(1)}¢ · $
                    {trade.size.toLocaleString(undefined, {
                      maximumFractionDigits: 0,
                    })}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                      trade.side === "BUY"
                        ? "bg-green-900 text-green-400"
                        : "bg-red-900 text-red-400"
                    }`}
                  >
                    {trade.side}
                  </span>
                  {trade.size >= 500 && (
                    <span className="text-xs">🐋</span>
                  )}
                  <span className="text-xs text-slate-500">
                    {getTimeAgo(trade.timestamp)}
                  </span>
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
