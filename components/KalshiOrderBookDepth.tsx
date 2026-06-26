"use client";

import type { KalshiOrderBook } from "@/lib/kalshiDetail";
import {
  bestOrderBookBid,
  deriveComplementAsks,
  sortBidsBestFirst,
} from "@/lib/kalshiDetail";

interface KalshiOrderBookDepthProps {
  orderbook: KalshiOrderBook;
}

function formatCents(price: number): string {
  return `${(price * 100).toFixed(1)}¢`;
}

function DepthLevels({
  levels,
  barClass,
  emptyLabel,
}: {
  levels: { price: number; size: number }[];
  barClass: string;
  emptyLabel: string;
}) {
  const maxSize = Math.max(...levels.map((l) => l.size), 1);

  if (levels.length === 0) {
    return <p className="text-xs text-slate-500">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-1.5">
      {levels.map((level, i) => (
        <div key={`${level.price}-${i}`} className="relative">
          <div
            className={`absolute inset-y-0 left-0 rounded ${barClass}`}
            style={{ width: `${(level.size / maxSize) * 100}%` }}
          />
          <div className="relative flex justify-between px-2 py-1 text-xs">
            <span className="font-mono text-white">
              {formatCents(level.price)}
            </span>
            <span className="text-slate-400">
              {level.size.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}{" "}
              contracts
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function OutcomeBook({
  title,
  titleClass,
  bids,
  asks,
  bidBarClass,
  askBarClass,
}: {
  title: string;
  titleClass: string;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  bidBarClass: string;
  askBarClass: string;
}) {
  const bestBid = bestOrderBookBid(bids);
  const bestAsk = asks[0] ?? null;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
      <p className={`text-sm font-semibold ${titleClass}`}>{title}</p>
      <div className="mb-4 mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
        <span>
          Best bid:{" "}
          <span className="font-mono text-white">
            {bestBid ? formatCents(bestBid.price) : "—"}
          </span>
        </span>
        <span>
          Best ask:{" "}
          <span className="font-mono text-white">
            {bestAsk ? formatCents(bestAsk.price) : "—"}
          </span>
        </span>
      </div>

      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        Bids
      </p>
      <DepthLevels
        levels={sortBidsBestFirst(bids)}
        barClass={bidBarClass}
        emptyLabel="No resting bids"
      />

      <p className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-slate-500">
        Asks
      </p>
      <DepthLevels
        levels={asks}
        barClass={askBarClass}
        emptyLabel="No resting asks"
      />
    </div>
  );
}

export default function KalshiOrderBookDepth({
  orderbook,
}: KalshiOrderBookDepthProps) {
  const yesAsks = deriveComplementAsks(orderbook.no);
  const noAsks = deriveComplementAsks(orderbook.yes);

  return (
    <div>
      <p className="mb-4 text-xs leading-relaxed text-slate-500">
        Kalshi lists resting buy orders on each outcome. Because Yes + No always
        sum to $1, a No bid at X¢ is the same liquidity as a Yes ask at 100−X¢
        — we show both sides of each book below.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <OutcomeBook
          title="Yes book"
          titleClass="text-green-400"
          bids={orderbook.yes}
          asks={yesAsks}
          bidBarClass="bg-green-500/20"
          askBarClass="bg-green-500/10"
        />
        <OutcomeBook
          title="No book"
          titleClass="text-red-400"
          bids={orderbook.no}
          asks={noAsks}
          bidBarClass="bg-red-500/20"
          askBarClass="bg-red-500/10"
        />
      </div>
    </div>
  );
}
