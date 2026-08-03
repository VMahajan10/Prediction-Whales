"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildPlatformFeed } from "@/lib/liveFeedMerge";
import type { ResolvedWhaleIdentity } from "@/lib/whaleIdentityResolver";
import type { TradeSummary } from "@/lib/polymarket";
import { usePolymarketSocketContext } from "@/lib/PolymarketSocketProvider";
import {
  evaluateLiveFeedTradeGate,
  passesLiveFeedTradeGate,
} from "@/lib/feedGate";
import {
  meetsFeedTieredStakeThreshold,
  resolvePolymarketTradeNotionalUsd,
} from "@/lib/feedQualification";
import { resolveFeedFilterCategoryLabel } from "@/lib/feedFilterDiagnostics";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import { translateWhaleTradeMarket } from "@/lib/marketTranslator";
import { pipelineEvKeyForWhale } from "@/lib/pipelineEvClient";
import { mergePipelineEvOntoWhale } from "@/lib/whaleCardEv";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  useQualifiedWalletFilter,
  type WalletQualification,
} from "@/lib/useQualifiedWalletFilter";
import { cacheWhaleTrade, resolveAndCacheWallet } from "@/lib/whaleCache";
import { useKalshiTrades } from "@/lib/useKalshiTrades";
import { usePipelineEvForWhales } from "@/lib/usePipelineEvIndex";
import { useWalletEnrichment } from "@/lib/useWalletEnrichment";
import {
  mergeWhaleTrades,
  tradeToWhale,
  type WhaleTrade,
} from "@/lib/whaleTrades";

/** Feed v1 — qualified whale feed is Polymarket-only (OQ-2 / Kalshi spike). */
const FEED_V1_EXCLUDE_KALSHI = true;
const KALSHI_WHALE_FEED_TRADES: WhaleTrade[] = FEED_V1_EXCLUDE_KALSHI ? [] : [];

const BACKFILL_TIMEOUT_MS = 15_000;
const BACKFILL_ATTEMPTS = 3;
const BACKFILL_RETRY_DELAY_MS = 1_500;

type BackfillApiTrade = TradeSummary & {
  whaleIdentity?: ResolvedWhaleIdentity;
  marketTranslation?: WhaleTrade["marketTranslation"];
  netEvPercent?: number | null;
  averageEv?: number | null;
};

async function fetchBackfillTrades(
  signal: AbortSignal
): Promise<BackfillApiTrade[]> {
  const timeout = new AbortController();
  const onAbort = () => timeout.abort();
  signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => timeout.abort(), BACKFILL_TIMEOUT_MS);

  try {
    const res = await fetch("/api/feed", { signal: timeout.signal });
    if (!res.ok) throw new Error(`Feed backfill HTTP ${res.status}`);
    const data: { trades?: BackfillApiTrade[] } = await res.json();
    return data.trades ?? [];
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

function byDetectedDesc(a: WhaleTrade, b: WhaleTrade): number {
  return b.detectedAt - a.detectedAt;
}

function queueWhaleTweetNotify(whale: WhaleTrade): void {
  void fetch("/api/whales/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(whale),
  }).catch(() => {
    // Non-fatal — live feed should continue if tweet queue fails.
  });
}

function reportFeedMetrics(input: {
  tradesDetected: number;
  gatePassedTrades: number;
  whaleWallets: string[];
}): void {
  if (input.tradesDetected <= 0 && input.gatePassedTrades <= 0) return;

  void fetch("/api/feed/metrics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).catch(() => {
    // Metrics are best-effort.
  });
}

function isPolymarketTradeQualifiedForFeed(
  trade: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  loggedRejects?: Set<string>
): boolean {
  if (trade.source !== "polymarket") return false;

  const pipelineKey = pipelineEvKeyForWhale(trade);
  const pipeline = pipelineKey ? pipelineEvIndex.get(pipelineKey) : undefined;
  const tradeEvPercent = resolveFeedTradeEvPercent(
    {
      price: trade.price,
      netEvPercent: trade.netEvPercent,
      grossEvPercent: trade.grossEvPercent,
    },
    pipeline
  );

  const category = resolveFeedFilterCategoryLabel(trade);
  const feedTrade = {
    stakeUsd: trade.usdNotional,
    title: trade.title,
    slug: trade.slug,
    eventSlug: trade.eventSlug,
    category,
    tradeEvPercent,
  };

  const qualified = passesLiveFeedTradeGate(feedTrade, {
    id: trade.id,
    source: "client",
    logRejection: !loggedRejects?.has(`${trade.id}:${tradeEvPercent ?? "na"}`),
  });
  if (!qualified) {
    const logKey = `${trade.id}:${tradeEvPercent ?? "na"}`;
    loggedRejects?.add(logKey);
  }

  return qualified;
}

function attachWhaleIdentity(
  trade: WhaleTrade,
  qualification: WalletQualification | undefined
): WhaleTrade {
  const marketTranslation =
    trade.marketTranslation ?? translateWhaleTradeMarket(trade) ?? undefined;
  const withIdentity =
    trade.whaleIdentity || !qualification?.identity
      ? trade
      : { ...trade, whaleIdentity: qualification.identity };

  if (!marketTranslation) return withIdentity;
  return { ...withIdentity, marketTranslation };
}

function isPolymarketTradeEligibleForFeed(
  trade: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  loggedRejects?: Set<string>
): boolean {
  if (
    !isPolymarketTradeQualifiedForFeed(
      trade,
      pipelineEvIndex,
      loggedRejects
    )
  ) {
    return false;
  }
  return translateWhaleTradeMarket(trade) != null;
}

export function useWhaleFeed() {
  const { whaleTrades: liveSocketTrades, connected } =
    usePolymarketSocketContext();
  const { ok: kalshiOk } = useKalshiTrades();
  useWalletEnrichment();
  const [backfill, setBackfill] = useState<WhaleTrade[]>([]);
  const [backfillLoaded, setBackfillLoaded] = useState(false);
  const seenHashes = useRef<Set<string>>(new Set());
  const liveDetectedAt = useRef<Map<string, number>>(new Map());
  const metricsDetected = useRef<Set<string>>(new Set());
  const metricsPassed = useRef<Set<string>>(new Set());
  const metricsFinalized = useRef<Set<string>>(new Set());
  const qualifiedNotified = useRef<Set<string>>(new Set());
  const loggedFilterRejects = useRef<Set<string>>(new Set());
  const [newWhale, setNewWhale] = useState<WhaleTrade | null>(null);

  useEffect(() => {
    const abort = new AbortController();

    const applyTrades = (trades: BackfillApiTrade[]) => {
      const whales = trades.map((t) => ({
        ...tradeToWhale(t, {
          detectedAt: t.timestamp * 1000,
          isLive: false,
          usdNotional: resolvePolymarketTradeNotionalUsd(t),
          source: "polymarket",
        }),
        whaleIdentity: t.whaleIdentity,
        marketTranslation: t.marketTranslation,
        netEvPercent: t.netEvPercent ?? null,
        averageEv: t.averageEv ?? t.netEvPercent ?? null,
      }));
      setBackfill(whales);
      for (const w of whales) {
        if (w.transactionHash) seenHashes.current.add(w.transactionHash);
        if (w.transactionHash && w.proxyWallet) {
          cacheWhaleTrade({
            id: w.id,
            title: w.title,
            side: w.side,
            outcome: w.outcome,
            price: w.price,
            size: w.size,
            timestamp: w.timestamp,
            transactionHash: w.transactionHash,
            proxyWallet: w.proxyWallet,
            eventSlug: w.eventSlug,
            slug: w.slug,
            conditionId: w.conditionId,
          });
        }
      }
    };

    const load = async () => {
      for (let attempt = 1; attempt <= BACKFILL_ATTEMPTS; attempt += 1) {
        if (abort.signal.aborted) return;
        try {
          const trades = await fetchBackfillTrades(abort.signal);
          if (abort.signal.aborted) return;
          applyTrades(trades);
          break;
        } catch {
          if (abort.signal.aborted) return;
          if (attempt === BACKFILL_ATTEMPTS) break;
          await new Promise((resolve) =>
            setTimeout(resolve, BACKFILL_RETRY_DELAY_MS * attempt)
          );
        }
      }

      if (!abort.signal.aborted) setBackfillLoaded(true);
    };

    void load();
    return () => abort.abort();
  }, []);

  const liveWhales = useMemo(() => {
    return liveSocketTrades.map((t) => {
      const key = t.transactionHash || t.id;
      let detectedAt = liveDetectedAt.current.get(key);
      if (!detectedAt) {
        detectedAt = Date.now();
        liveDetectedAt.current.set(key, detectedAt);
      }
      return tradeToWhale(t, {
        detectedAt,
        isLive: true,
        usdNotional: t.usdNotional,
        source: "polymarket",
      });
    });
  }, [liveSocketTrades]);

  const polymarketWhales = useMemo(
    () => mergeWhaleTrades(liveWhales, backfill),
    [liveWhales, backfill]
  );

  const polymarketWalletAddresses = useMemo(
    () =>
      polymarketWhales
        .map((trade) => trade.proxyWallet?.trim().toLowerCase())
        .filter((wallet): wallet is string => Boolean(wallet)),
    [polymarketWhales]
  );
  const walletQualifications = useQualifiedWalletFilter(polymarketWalletAddresses);
  const { index: pipelineEvIndex } = usePipelineEvForWhales(polymarketWhales);

  const qualifiedPolymarketWhales = useMemo(() => {
    return polymarketWhales
      .filter((trade) =>
        isPolymarketTradeEligibleForFeed(
          trade,
          pipelineEvIndex,
          loggedFilterRejects.current
        )
      )
      .map((trade) => {
        const pipelineKey = pipelineEvKeyForWhale(trade);
        const withIdentity = attachWhaleIdentity(
          trade,
          trade.proxyWallet
            ? walletQualifications.get(trade.proxyWallet.trim().toLowerCase())
            : undefined
        );
        return mergePipelineEvOntoWhale(
          withIdentity,
          pipelineKey ? pipelineEvIndex.get(pipelineKey) : undefined
        );
      });
  }, [polymarketWhales, walletQualifications, pipelineEvIndex]);

  useEffect(() => {
    if (!backfillLoaded) return;

    let newDetected = 0;
    let newPassed = 0;
    const passedWallets: string[] = [];

    for (const whale of liveWhales) {
      const key = whale.transactionHash || whale.id;
      if (!key || metricsFinalized.current.has(key)) continue;

      const category = resolveFeedFilterCategoryLabel(whale);
      const pipelineKey = pipelineEvKeyForWhale(whale);
      const pipeline = pipelineKey ? pipelineEvIndex.get(pipelineKey) : undefined;
      const tradeEvPercent = resolveFeedTradeEvPercent(
        {
          price: whale.price,
          netEvPercent: whale.netEvPercent,
          grossEvPercent: whale.grossEvPercent,
        },
        pipeline
      );

      if (
        !meetsFeedTieredStakeThreshold({
          stakeUsd: whale.usdNotional,
          title: whale.title,
          slug: whale.slug,
          eventSlug: whale.eventSlug,
          category,
        })
      ) {
        evaluateLiveFeedTradeGate(
          {
            stakeUsd: whale.usdNotional,
            title: whale.title,
            slug: whale.slug,
            eventSlug: whale.eventSlug,
            category,
            tradeEvPercent: null,
          },
          { id: whale.id, source: "client" }
        );
        metricsFinalized.current.add(key);
        continue;
      }

      if (!metricsDetected.current.has(key)) {
        metricsDetected.current.add(key);
        newDetected += 1;
      }

      const qualified = isPolymarketTradeQualifiedForFeed(
        whale,
        pipelineEvIndex,
        loggedFilterRejects.current
      );

      if (qualified) {
        if (!metricsPassed.current.has(key)) {
          metricsPassed.current.add(key);
          newPassed += 1;
          const wallet = whale.proxyWallet?.trim().toLowerCase();
          if (wallet) passedWallets.push(wallet);
        }
        metricsFinalized.current.add(key);
        continue;
      }

      if (tradeEvPercent != null && Number.isFinite(tradeEvPercent)) {
        metricsFinalized.current.add(key);
      }
    }

    reportFeedMetrics({
      tradesDetected: newDetected,
      gatePassedTrades: newPassed,
      whaleWallets: passedWallets,
    });
  }, [liveWhales, pipelineEvIndex, backfillLoaded]);

  useEffect(() => {
    if (!backfillLoaded) return;

    for (const t of liveSocketTrades) {
      const key = t.transactionHash;
      if (!key || seenHashes.current.has(key)) continue;

      seenHashes.current.add(key);
      const detectedAt = Date.now();
      liveDetectedAt.current.set(key, detectedAt);

      cacheWhaleTrade({
        id: t.id,
        title: t.title,
        side: t.side,
        outcome: t.outcome,
        price: t.price,
        size: t.usdNotional,
        timestamp: t.timestamp,
        transactionHash: t.transactionHash,
        assetId: t.assetId,
        eventSlug: t.eventSlug,
        slug: t.slug,
        conditionId: t.conditionId,
      });

      void resolveAndCacheWallet(t.transactionHash, t.assetId);
    }
  }, [liveSocketTrades, backfillLoaded]);

  useEffect(() => {
    if (!backfillLoaded) return;

    for (const whale of liveWhales) {
      const key = whale.transactionHash || whale.id;
      if (!key || !whale.isLive || qualifiedNotified.current.has(key)) continue;

      if (
        !isPolymarketTradeEligibleForFeed(
          whale,
          pipelineEvIndex,
          loggedFilterRejects.current
        )
      )
        continue;

      qualifiedNotified.current.add(key);
      const wallet = whale.proxyWallet?.trim().toLowerCase();
      const qualification = wallet
        ? walletQualifications.get(wallet)
        : undefined;
      const enriched = attachWhaleIdentity(whale, qualification);
      setNewWhale(enriched);
      queueWhaleTweetNotify(enriched);
    }
  }, [liveWhales, backfillLoaded, walletQualifications, pipelineEvIndex]);

  const whales = useMemo(
    () =>
      buildPlatformFeed(
        qualifiedPolymarketWhales,
        KALSHI_WHALE_FEED_TRADES,
        "all",
        byDetectedDesc
      ),
    [qualifiedPolymarketWhales]
  );

  const dismissNewWhale = useCallback(() => setNewWhale(null), []);

  return {
    whales,
    connected,
    kalshiOk,
    backfillLoaded,
    newWhale,
    dismissNewWhale,
  };
}
