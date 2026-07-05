"use client";

import { useCallback, useEffect, useState } from "react";
import type { ArbitrageWindow } from "@/lib/arbitrageFinder/types";

export interface UseArbitrageWindowInput {
  pmTokenId?: string | null;
  kalshiTicker?: string | null;
  baseStakeUsd?: number | null;
  bestOnly?: boolean;
  enabled?: boolean;
  refreshMs?: number;
}

interface ArbitrageWindowApiResponse {
  pairKey?: string | null;
  windows?: ArbitrageWindow[];
  best?: ArbitrageWindow | null;
  fromCache?: boolean;
  error?: string;
}

export function useArbitrageWindow(input: UseArbitrageWindowInput) {
  const [window, setWindow] = useState<ArbitrageWindow | null>(null);
  const [windows, setWindows] = useState<ArbitrageWindow[]>([]);
  const [pairKey, setPairKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);

  const enabled = input.enabled !== false;
  const hasIdentifier = !!(input.pmTokenId || input.kalshiTicker);

  const load = useCallback(async () => {
    if (!enabled || !hasIdentifier) {
      setWindow(null);
      setWindows([]);
      setPairKey(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (input.pmTokenId) params.set("pmTokenId", input.pmTokenId);
      if (input.kalshiTicker) params.set("kalshiTicker", input.kalshiTicker);
      if (input.baseStakeUsd != null) {
        params.set("stake", String(input.baseStakeUsd));
      }
      if (input.bestOnly) params.set("bestOnly", "true");

      const res = await fetch(`/api/arbitrage/windows?${params.toString()}`);
      const data = (await res.json()) as ArbitrageWindowApiResponse;

      if (!res.ok) {
        setWindow(null);
        setWindows([]);
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }

      const nextWindows = data.windows ?? [];
      setWindows(nextWindows);
      setWindow(data.best ?? nextWindows.find((w) => w.isActionable) ?? null);
      setPairKey(data.pairKey ?? null);
      setFromCache(data.fromCache ?? false);
    } catch (err) {
      setWindow(null);
      setWindows([]);
      setError(
        err instanceof Error ? err.message : "Arbitrage window fetch failed"
      );
    } finally {
      setLoading(false);
    }
  }, [
    enabled,
    hasIdentifier,
    input.pmTokenId,
    input.kalshiTicker,
    input.baseStakeUsd,
    input.bestOnly,
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

  return {
    window,
    windows,
    pairKey,
    loading,
    error,
    fromCache,
    refresh: load,
  };
}
