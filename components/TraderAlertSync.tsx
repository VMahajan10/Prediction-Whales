"use client";

import { useEffect, useRef } from "react";
import { getCachedWhaleTrade } from "@/lib/whaleCache";
import { walletLabel } from "@/lib/bookmarkedTraders";
import { useBookmarkedTraders } from "@/lib/useBookmarkedTraders";
import {
  alertFromWhaleTrade,
  upsertTraderAlert,
} from "@/lib/traderAlerts";
import type { WhaleTrade } from "@/lib/whaleTrades";

function walletForWhale(trade: WhaleTrade): string | undefined {
  return (
    trade.proxyWallet?.toLowerCase() ??
    getCachedWhaleTrade(trade.transactionHash)?.proxyWallet?.toLowerCase()
  );
}

interface TraderAlertSyncProps {
  whales: WhaleTrade[];
}

export default function TraderAlertSync({ whales }: TraderAlertSyncProps) {
  const { bookmarks } = useBookmarkedTraders();
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (bookmarks.length === 0 || whales.length === 0) return;

    const bookmarkMap = new Map(
      bookmarks.map((b) => [b.wallet, b] as const)
    );

    for (const trade of whales) {
      const wallet = walletForWhale(trade);
      if (!wallet) continue;

      const bookmark = bookmarkMap.get(wallet);
      if (!bookmark || bookmark.alertsEnabled === false) continue;

      const id =
        trade.source === "kalshi"
          ? `kalshi:${trade.id}`
          : trade.transactionHash || trade.id;
      if (!id || seen.current.has(id)) continue;

      seen.current.add(id);
      upsertTraderAlert(
        alertFromWhaleTrade(
          trade,
          wallet,
          bookmark.label || walletLabel(wallet)
        )
      );
    }
  }, [whales, bookmarks]);

  return null;
}
