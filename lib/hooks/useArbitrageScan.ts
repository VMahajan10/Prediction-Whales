"use client";

import { useCallback, useEffect, useState } from "react";
import { topArbitrageWindows } from "@/lib/arbitrageFinder/feedUtils";
import type { ArbitrageWindow } from "@/lib/arbitrageFinder/types";

export interface UseArbitrageScanOptions {
  mappingLimit?: number;
  top?: number;
  stakeUsd?: number | null;
  refreshMs?: number;
  enabled?: boolean;
}

interface ArbitrageScanApiResponse {
  windows?: ArbitrageWindow[];
  locks?: ArbitrageWindow[];
  scannedPairs?: number;
  actionableCount?: number;
  scanDurationMs?: number;
  stakeUsd?: number | null;
  error?: string;
}

const DEFAULT_MAPPING_LIMIT = 250;
const DEFAULT_TOP = 8;
const DEFAULT_REFRESH_MS = 60_000;

export function useArbitrageScan(options: UseArbitrageScanOptions = {}) {
  const {
    mappingLimit = DEFAULT_MAPPING_LIMIT,
    top = DEFAULT_TOP,
    stakeUsd = null,
    refreshMs = DEFAULT_REFRESH_MS,
    enabled = true,
  } = options;

  const [windows, setWindows] = useState<ArbitrageWindow[]>([]);
  const [scannedPairs, setScannedPairs] = useState(0);
  const [actionableCount, setActionableCount] = useState(0);
  const [scanDurationMs, setScanDurationMs] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled) {
      setWindows([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        actionableOnly: "true",
        mappingLimit: String(mappingLimit),
        top: String(top),
      });
      if (stakeUsd != null && stakeUsd > 0) {
        params.set("stake", String(stakeUsd));
      }

      const res = await fetch(`/api/locks?${params.toString()}`);
      const data = (await res.json()) as ArbitrageScanApiResponse;

      const rawWindows = data.windows ?? data.locks ?? [];
      const actionable = topArbitrageWindows(rawWindows, top);
      setWindows(actionable);
      setScannedPairs(data.scannedPairs ?? 0);
      setActionableCount(data.actionableCount ?? actionable.length);
      setScanDurationMs(data.scanDurationMs ?? 0);
      setError(null);
    } catch (err) {
      console.error(
        "[useArbitrageScan] lock scan fetch failed",
        err instanceof Error ? err.message : err
      );
      setWindows([]);
      setError(null);
    } finally {
      setLoading(false);
    }
  }, [enabled, mappingLimit, stakeUsd, top]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => {
      void load();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [enabled, load, refreshMs]);

  return {
    windows,
    scannedPairs,
    actionableCount,
    scanDurationMs,
    loading,
    error,
    refresh: load,
  };
}
