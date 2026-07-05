"use client";

import { useCallback, useEffect, useState } from "react";
import {
  buildNeutralArbitrageSnapshot,
  type ArbitrageDisplaySnapshot,
} from "@/lib/arbitrageFinder/displayTypes";

export interface UseArbitrageDisplayInput {
  source?: "polymarket" | "kalshi" | "auto";
  pmTokenId?: string | null;
  kalshiTicker?: string | null;
  tradeOutcomeSide?: string | null;
  tradePrice?: number | null;
  title?: string | null;
  slug?: string | null;
  pmMid?: number | null;
  baseStakeUsd?: number | null;
  enabled?: boolean;
  refreshMs?: number;
}

interface ArbitrageDisplayApiResponse {
  snapshot?: ArbitrageDisplaySnapshot | null;
  error?: string;
}

export function useArbitrageDisplay(input: UseArbitrageDisplayInput) {
  const [snapshot, setSnapshot] = useState<ArbitrageDisplaySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabled = input.enabled !== false;
  const hasIdentifier = !!(input.pmTokenId || input.kalshiTicker);
  const fallbackSnapshot = useCallback(
    () =>
      buildNeutralArbitrageSnapshot({
        venue:
          input.source === "kalshi" || (!input.pmTokenId && input.kalshiTicker)
            ? "kalshi"
            : "polymarket",
        contractId: input.pmTokenId ?? input.kalshiTicker ?? "unknown",
        referencePrice: input.tradePrice ?? input.pmMid,
      }),
    [
      input.source,
      input.pmTokenId,
      input.kalshiTicker,
      input.tradePrice,
      input.pmMid,
    ]
  );

  const load = useCallback(async () => {
    if (!enabled || !hasIdentifier) {
      setSnapshot(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (input.source) params.set("source", input.source);
      if (input.pmTokenId) params.set("pmTokenId", input.pmTokenId);
      if (input.kalshiTicker) params.set("kalshiTicker", input.kalshiTicker);
      if (input.tradeOutcomeSide) {
        params.set("tradeOutcomeSide", input.tradeOutcomeSide);
      }
      if (input.tradePrice != null) {
        params.set("tradePrice", String(input.tradePrice));
      }
      if (input.title) params.set("title", input.title);
      if (input.slug) params.set("slug", input.slug);
      if (input.pmMid != null) params.set("pmMid", String(input.pmMid));
      if (input.baseStakeUsd != null) {
        params.set("stake", String(input.baseStakeUsd));
      }

      const res = await fetch(`/api/arbitrage/display?${params.toString()}`);
      const data = (await res.json()) as ArbitrageDisplayApiResponse;

      if (!res.ok) {
        setSnapshot(fallbackSnapshot());
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }

      setSnapshot(data.snapshot ?? fallbackSnapshot());
      if (!data.snapshot) {
        setError(data.error ?? "No arbitrage snapshot");
      }
    } catch (err) {
      setSnapshot(fallbackSnapshot());
      setError(
        err instanceof Error ? err.message : "Arbitrage display fetch failed"
      );
    } finally {
      setLoading(false);
    }
  }, [
    enabled,
    hasIdentifier,
    input.source,
    input.pmTokenId,
    input.kalshiTicker,
    input.tradeOutcomeSide,
    input.tradePrice,
    input.title,
    input.slug,
    input.pmMid,
    input.baseStakeUsd,
    fallbackSnapshot,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!enabled || !hasIdentifier) return undefined;
    const refreshMs = input.refreshMs ?? 20_000;
    const timer = setInterval(() => {
      void load();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [enabled, hasIdentifier, input.refreshMs, load]);

  return { snapshot, loading, error, refresh: load };
}
