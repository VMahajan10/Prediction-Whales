"use client";

import { useEffect, useRef } from "react";
import { KALSHI_TRADES_POLL_MS } from "@/lib/ingestionPollConfig";
import {
  listCachedTradesMissingWallet,
  resolveAndCacheWallet,
} from "@/lib/whaleCache";

const POLL_INTERVAL_MS = KALSHI_TRADES_POLL_MS;
const MAX_PER_TICK = 10;

/**
 * Background resolver for live WebSocket whales missing proxyWallet.
 * Uses on-chain + per-asset Data API via /api/wallet/resolve.
 */
export function useWalletEnrichment() {
  const inFlight = useRef(false);

  useEffect(() => {
    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const missing = listCachedTradesMissingWallet().slice(0, MAX_PER_TICK);
        for (const { hash, assetId } of missing) {
          await resolveAndCacheWallet(hash, assetId);
        }
      } finally {
        inFlight.current = false;
      }
    };

    void tick();
    const interval = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);
}
