"use client";

import { useEffect, useState } from "react";
import type { TradeSummary } from "@/lib/polymarket";
import { resolveAndCacheWallet } from "@/lib/whaleCache";

const MAX_ATTEMPTS = 10;
const RETRY_MS = 3000;

export function useResolvedWallet(trade: TradeSummary | null) {
  const [resolvedWallet, setResolvedWallet] = useState<string | undefined>(
    undefined
  );
  const [walletResolutionFailed, setWalletResolutionFailed] = useState(false);

  useEffect(() => {
    if (!trade) {
      setResolvedWallet(undefined);
      setWalletResolutionFailed(false);
      return;
    }

    if (trade.proxyWallet) {
      setResolvedWallet(trade.proxyWallet);
      setWalletResolutionFailed(false);
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    setResolvedWallet(undefined);
    setWalletResolutionFailed(false);

    const resolve = async () => {
      if (cancelled) return;
      if (attempts >= MAX_ATTEMPTS) {
        setWalletResolutionFailed(true);
        return;
      }
      attempts++;
      try {
        const wallet = await resolveAndCacheWallet(
          trade.transactionHash,
          trade.assetId
        );
        if (wallet && !cancelled) {
          setResolvedWallet(wallet);
          setWalletResolutionFailed(false);
          return;
        }
      } catch {
        // Retry below
      }
      if (!cancelled && attempts < MAX_ATTEMPTS) {
        retryTimer = setTimeout(() => {
          void resolve();
        }, RETRY_MS);
      } else if (!cancelled) {
        setWalletResolutionFailed(true);
      }
    };

    void resolve();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [trade?.transactionHash, trade?.proxyWallet, trade?.assetId]);

  return { resolvedWallet, walletResolutionFailed };
}
