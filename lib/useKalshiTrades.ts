"use client";

import { useEffect, useRef, useState } from "react";
import type { FeedTrade } from "@/lib/kalshiTrades";

const POLL_MS = 4_000;

export function useKalshiTrades() {
  const [trades, setTrades] = useState<FeedTrade[]>([]);
  const [ok, setOk] = useState(true);
  const tradeMap = useRef<Map<string, FeedTrade>>(new Map());
  const minTsRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const params = new URLSearchParams();
        if (minTsRef.current != null && minTsRef.current > 0) {
          params.set("min_ts", String(minTsRef.current));
        }
        const qs = params.toString();
        const url = qs ? `/api/kalshi/trades?${qs}` : "/api/kalshi/trades";
        const res = await fetch(url);
        const data = await res.json();

        if (!mounted) return;

        if (data.ok === false) {
          setOk(false);
        } else {
          setOk(true);
          const incoming = (data.trades ?? []) as FeedTrade[];

          let maxTs = minTsRef.current ?? 0;

          for (const t of incoming) {
            if (!t?.id) continue;
            tradeMap.current.set(t.id, t);
            if (t.timestamp > maxTs) maxTs = t.timestamp;
          }

          if (maxTs > 0) {
            minTsRef.current = maxTs;
          }

          const sorted = Array.from(tradeMap.current.values()).sort(
            (a, b) => b.timestamp - a.timestamp
          );
          setTrades(sorted);
        }
      } catch {
        if (mounted) setOk(false);
      }

      if (mounted) {
        timer = setTimeout(() => void poll(), POLL_MS);
      }
    };

    void poll();

    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return { trades, ok };
}
