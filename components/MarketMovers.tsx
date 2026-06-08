"use client";

import { useCallback, useEffect, useState } from "react";
import { formatVolumeUsd } from "@/lib/polymarket";
import { detectMovers, type Market, type Mover } from "@/lib/marketMovers";

const REFRESH_INTERVAL_MS = 60_000;

interface MarketMoversProps {
  markets: Market[];
}

function truncateQuestion(question: string, maxLen: number): string {
  if (question.length <= maxLen) return question;
  return `${question.slice(0, maxLen)}…`;
}

function formatDeltaBadge(delta: number): string {
  const pct = (delta * 100).toFixed(1);
  return delta >= 0 ? `▲ +${pct}%` : `▼ ${pct}%`;
}

export default function MarketMovers({ markets }: MarketMoversProps) {
  const [movers, setMovers] = useState<Mover[]>([]);
  const [loading, setLoading] = useState(true);

  const scan = useCallback(async () => {
    setLoading(true);
    try {
      const detected = await detectMovers(markets);
      setMovers(detected);
    } catch {
      setMovers([]);
    } finally {
      setLoading(false);
    }
  }, [markets]);

  useEffect(() => {
    scan();
    const interval = setInterval(scan, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [scan]);

  if (loading) {
    return (
      <p className="py-4 text-sm text-pulse-muted animate-pulse">
        Scanning markets...
      </p>
    );
  }

  if (movers.length === 0) {
    return (
      <p className="py-4 text-sm text-pulse-muted">
        No significant moves in the last hour
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {movers.map((mover) => (
        <li
          key={`${mover.question}-${mover.currentProb}`}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-pulse-border bg-pulse-card/60 px-3 py-2"
        >
          <p className="min-w-0 flex-1 text-sm text-white">
            {truncateQuestion(mover.question, 60)}
          </p>
          <div className="flex shrink-0 items-center gap-3">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                mover.delta >= 0
                  ? "bg-pulse-yes/20 text-pulse-yes"
                  : "bg-red-500/20 text-red-400"
              }`}
            >
              {formatDeltaBadge(mover.delta)}
            </span>
            <span className="text-sm font-medium text-white">
              {(mover.currentProb * 100).toFixed(1)}%
            </span>
            <span className="text-sm text-pulse-muted">
              {formatVolumeUsd(mover.volume)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
