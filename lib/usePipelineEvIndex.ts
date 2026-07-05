"use client";

import { useEffect, useState } from "react";
import type { FeedTrade } from "@/lib/kalshiTrades";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import type { WhaleTrade } from "@/lib/whaleTrades";
import {
  buildWhalePipelineEvRequests,
  fetchPipelineEvBatch,
  normalizePipelineEvEntry,
  subscribePipelineEvForTrades,
} from "@/lib/pipelineEvClient";

export function usePipelineEvIndex(trades: FeedTrade[]) {
  const [index, setIndex] = useState<Map<string, PipelineTradeEv>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(
    () =>
      subscribePipelineEvForTrades(trades, (nextIndex, nextLoading) => {
        setIndex(nextIndex);
        setLoading(nextLoading);
      }),
    [trades]
  );

  return { index, loading };
}

export function usePipelineTradeEv(input: {
  source: "polymarket" | "kalshi";
  tokenId?: string;
  kalshiTicker?: string;
  tradePrice?: number;
  enabled?: boolean;
}) {
  const [ev, setEv] = useState<PipelineTradeEv | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (input.enabled === false) return;
    if (input.source === "polymarket" && !input.tokenId) return;
    if (input.source === "kalshi" && !input.kalshiTicker) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const params = new URLSearchParams({ source: input.source });
        if (input.tokenId) params.set("tokenId", input.tokenId);
        if (input.kalshiTicker) params.set("kalshiTicker", input.kalshiTicker);
        if (input.tradePrice != null) {
          params.set("price", String(input.tradePrice));
        }

        const res = await fetch(`/api/ev/trades?${params.toString()}`);
        if (cancelled) return;

        const data: { entry?: PipelineTradeEv | null; error?: string } =
          await res.json();

        if (!res.ok) {
          setEv(null);
          setError(data.error ?? `Pipeline EV HTTP ${res.status}`);
          return;
        }

        const normalized = normalizePipelineEvEntry(data.entry ?? null);
        console.log("[usePipelineTradeEv] hydrated", {
          source: input.source,
          tokenId: input.tokenId,
          kalshiTicker: input.kalshiTicker,
          mappingPairKey: normalized?.mappingPairKey,
          status: normalized?.status,
        });
        setEv(normalized);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setEv(null);
          setError(
            err instanceof Error ? err.message : "Pipeline EV fetch failed"
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    input.source,
    input.tokenId,
    input.kalshiTicker,
    input.tradePrice,
    input.enabled,
  ]);

  return { ev, loading, error };
}

const WHALE_EV_REFRESH_MS = 45_000;

export function usePipelineEvForWhales(whales: WhaleTrade[]) {
  const [index, setIndex] = useState<Map<string, PipelineTradeEv>>(new Map());
  const [loading, setLoading] = useState(true);

  const whalesKey = whales
    .map(
      (w) =>
        `${w.source}:${w.id}:${w.assetId ?? ""}:${w.ticker ?? ""}:${w.price}`
    )
    .join("|");

  useEffect(() => {
    const items = buildWhalePipelineEvRequests(whales);
    if (items.length === 0) {
      setIndex(new Map());
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const load = async () => {
      try {
        const fetched = await fetchPipelineEvBatch(items);
        if (!cancelled) {
          setIndex((prev) => {
            const merged = new Map(prev);
            Array.from(fetched.entries()).forEach(([key, value]) => {
              merged.set(key, value);
            });
            return merged;
          });
        }
      } catch {
        // Keep prior index entries on refresh failure.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const timer = setInterval(() => {
      void load();
    }, WHALE_EV_REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [whalesKey]);

  return { index, loading };
}
