"use client";

import type { KalshiOrderBook } from "@/lib/kalshiDetail";

interface KalshiOrderBookDepthProps {
  orderbook: KalshiOrderBook;
}

function DepthColumn({
  title,
  subtitle,
  levels,
  barClass,
  titleClass,
}: {
  title: string;
  subtitle?: string;
  levels: { price: number; size: number }[];
  barClass: string;
  titleClass: string;
}) {
  const maxSize = Math.max(...levels.map((l) => l.size), 1);

  return (
    <div>
      <p className={`text-sm font-medium ${titleClass}`}>{title}</p>
      {subtitle && (
        <p className="mb-3 text-xs text-slate-500">{subtitle}</p>
      )}
      {!subtitle && <div className="mb-3" />}
      {levels.length === 0 ? (
        <p className="text-xs text-slate-500">No depth available</p>
      ) : (
        <div className="space-y-1.5">
          {levels.map((level, i) => (
            <div key={`${level.price}-${i}`} className="relative">
              <div
                className={`absolute inset-y-0 left-0 rounded ${barClass}`}
                style={{ width: `${(level.size / maxSize) * 100}%` }}
              />
              <div className="relative flex justify-between px-2 py-1 text-xs">
                <span className="font-mono text-white">
                  {(level.price * 100).toFixed(1)}¢
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
      )}
    </div>
  );
}

export default function KalshiOrderBookDepth({
  orderbook,
}: KalshiOrderBookDepthProps) {
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <DepthColumn
        title="Yes bids"
        subtitle="Resting buy orders for Yes contracts"
        levels={orderbook.yes}
        titleClass="text-green-400"
        barClass="bg-green-500/20"
      />
      <DepthColumn
        title="No bids"
        subtitle="Resting buy orders for No contracts"
        levels={orderbook.no}
        titleClass="text-red-400"
        barClass="bg-red-500/20"
      />
    </div>
  );
}
