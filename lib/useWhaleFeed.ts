"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildPlatformFeed } from "@/lib/liveFeedMerge";
import type { ResolvedWhaleIdentity } from "@/lib/whaleIdentityResolver";
import type { TradeSummary } from "@/lib/polymarket";
import { usePolymarketSocketContext } from "@/lib/PolymarketSocketProvider";
import {
  aggregatePolymarketFeedMetrics,
  collectPolymarketWalletAddresses,
  isPolymarketTradeEligibleForFeed,
  isRenderableFeedWhale,
  isVisibleInClientFeed,
  passesPolymarketClientFeedAdmissionGate,
  passesPolymarketWalletCredibilityForClient,
} from "@/lib/whaleFeedClientQualification";
import {
  meetsProductFeedStakeThreshold,
  meetsProductFeedEvThreshold,
  resolvePolymarketTradeNotionalUsd,
} from "@/lib/feedQualification";
import {
  retainLastNonEmpty,
  trimFeedBufferWithVenueFloor,
} from "@/lib/feed/feedRetention";
import {
  logFeedVolumeDiagnostics,
  summarizeFeedVolumeDrops,
} from "@/lib/feed/feedVolumeDiagnostics";
import { recentTradeToWhale } from "@/lib/feed/whaleFeedHydration";
import type { FeedTrade } from "@/lib/feedTradeTypes";
import {
  isKalshiTradeVisibleInUserFeed,
  kalshiFeedTradeToWhale,
  resolveKalshiFeedTradeEvPercent,
  type KalshiFeedTradeInput,
} from "@/lib/feed/kalshiFeedTrades";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import { translateWhaleTradeMarket } from "@/lib/marketTranslator";
import {
  pipelineEvKeyForWhale,
  resolvePipelineEvForWhale,
} from "@/lib/pipelineEvClient";
import {
  mergePipelineEvOntoWhale,
  stampWhaleFeedAdmissionEv,
  whaleHasStampedFeedEv,
} from "@/lib/whaleCardEv";
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

/**
 * Kalshi appears as anonymous market flow — same card, no trader identity.
 * Gated on stake + trade EV only; wallet credibility is Polymarket-only because
 * Kalshi exposes no persistent trader id (docs/Kalshi Whale Attribution Audit.md).
 */
const KALSHI_FEED_ENABLED = true;

/** API seed target — matches `/api/trades/recent` limit. */
export const WHALE_FEED_SEED_LIMIT = 50;
/** Live websocket buffer cap — prepend new trades, trim to this size. */
export const WHALE_FEED_LIVE_MAX = 50;

const BACKFILL_TIMEOUT_MS = 15_000;
const BACKFILL_ATTEMPTS = 3;
const BACKFILL_RETRY_DELAY_MS = 1_500;
const RECENT_SEED_TIMEOUT_MS = 10_000;
const RECENT_SEED_ATTEMPTS = 3;
const RECENT_SEED_RETRY_DELAY_MS = 1_000;

type RecentApiResponse = {
  trades?: Array<FeedTrade & { netEvPercent?: number | null }>;
};

type BackfillApiTrade = TradeSummary & {
  whaleIdentity?: ResolvedWhaleIdentity;
  whaleAlias?: string;
  displayName?: string;
  marketTranslation?: WhaleTrade["marketTranslation"];
  netEvPercent?: number | null;
  averageEv?: number | null;
  category?: string;
};

type BackfillApiResponse = {
  trades?: BackfillApiTrade[];
  kalshiTrades?: KalshiFeedTradeInput[];
};

type BackfillPayload = {
  polymarket: BackfillApiTrade[];
  kalshi: KalshiFeedTradeInput[];
};

function kalshiFeedTradeFromApi(trade: KalshiFeedTradeInput): KalshiFeedTradeInput {
  return {
    id: trade.id,
    title: trade.title,
    outcome: trade.outcome,
    side: trade.side,
    price: trade.price,
    usdNotional: trade.usdNotional,
    timestamp: trade.timestamp,
    ticker: trade.ticker,
    selectionLabel: trade.selectionLabel,
    netEvPercent: trade.netEvPercent ?? null,
    category: trade.category,
  };
}

function isKalshiWhaleEligibleForLiveFeed(
  whale: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  loggedRejects?: Set<string>
): boolean {
  const logKey = `${whale.id}:kalshi`;
  const visible = isKalshiTradeVisibleInUserFeed(whale, pipelineEvIndex, {
    id: whale.id,
    logRejection: !loggedRejects?.has(logKey),
  });
  if (!visible) {
    loggedRejects?.add(logKey);
  }
  return visible;
}

async function fetchRecentSeedTrades(signal: AbortSignal): Promise<WhaleTrade[]> {
  const timeout = new AbortController();
  const onAbort = () => timeout.abort();
  signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => timeout.abort(), RECENT_SEED_TIMEOUT_MS);

  try {
    const res = await fetch("/api/trades/recent", { signal: timeout.signal });
    if (!res.ok) throw new Error(`Recent trades HTTP ${res.status}`);
    const data = (await res.json()) as RecentApiResponse;
    return (data.trades ?? [])
      .map(recentTradeToWhale)
      .filter((trade): trade is WhaleTrade => trade != null);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function fetchBackfillTrades(
  signal: AbortSignal
): Promise<BackfillPayload> {
  const timeout = new AbortController();
  const onAbort = () => timeout.abort();
  signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => timeout.abort(), BACKFILL_TIMEOUT_MS);

  try {
    const res = await fetch("/api/feed", { signal: timeout.signal });
    if (!res.ok) throw new Error(`Feed backfill HTTP ${res.status}`);
    const data: BackfillApiResponse = await res.json();
    return {
      polymarket: data.trades ?? [],
      kalshi: (data.kalshiTrades ?? []).map(kalshiFeedTradeFromApi),
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

function byDetectedDesc(a: WhaleTrade, b: WhaleTrade): number {
  return b.detectedAt - a.detectedAt;
}

function whaleKey(trade: WhaleTrade): string {
  return trade.source === "kalshi"
    ? `kalshi:${trade.id}`
    : trade.transactionHash || trade.id;
}

/** Prepend new whales, dedupe by key, cap at WHALE_FEED_LIVE_MAX. */
function prependWhaleBuffer(prev: WhaleTrade[], incoming: WhaleTrade[]): WhaleTrade[] {
  const seen = new Set<string>();
  const merged: WhaleTrade[] = [];

  for (const trade of incoming) {
    const key = whaleKey(trade);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(trade);
  }
  for (const trade of prev) {
    const key = whaleKey(trade);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(trade);
  }

  return trimFeedBufferWithVenueFloor(merged, WHALE_FEED_LIVE_MAX);
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
    body: JSON.stringify({
      venue: "polymarket",
      ...input,
    }),
  }).catch(() => {
    // Metrics are best-effort.
  });
}

function attachWhaleIdentity(
  trade: WhaleTrade,
  qualification: WalletQualification | undefined
): WhaleTrade {
  const marketTranslation = translateWhaleTradeMarket(trade) ?? undefined;
  const withIdentity =
    trade.whaleIdentity || !qualification?.identity
      ? trade
      : { ...trade, whaleIdentity: qualification.identity };

  if (!marketTranslation) return withIdentity;
  return { ...withIdentity, marketTranslation };
}

function resolveWhaleTradeEvPercent(
  trade: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>
): number | null {
  if (trade.source === "kalshi") {
    const pipeline = resolvePipelineEvForWhale(pipelineEvIndex, trade);
    return resolveKalshiFeedTradeEvPercent(trade, pipeline);
  }

  const pipeline = resolvePipelineEvForWhale(pipelineEvIndex, trade);
  return resolveFeedTradeEvPercent(
    {
      price: trade.price,
      netEvPercent: trade.netEvPercent,
      grossEvPercent: trade.grossEvPercent,
    },
    pipeline
  );
}

function seedKalshiWhalesToBuffer(trades: KalshiFeedTradeInput[]): WhaleTrade[] {
  return trades
    .filter((trade) => meetsProductFeedStakeThreshold(trade.usdNotional))
    .map((trade) =>
      kalshiFeedTradeToWhale(kalshiFeedTradeFromApi(trade), {
        isLive: false,
        netEvPercent: trade.netEvPercent ?? null,
      })
    )
    .filter((trade) => meetsProductFeedEvThreshold(trade.netEvPercent))
    .map((trade) =>
      stampWhaleFeedAdmissionEv(trade, trade.netEvPercent as number)
    )
    .sort(byDetectedDesc)
    .slice(0, WHALE_FEED_SEED_LIMIT);
}

function stampWhaleForFeedAdmission(
  trade: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>
): WhaleTrade | null {
  if (whaleHasStampedFeedEv(trade)) {
    return meetsProductFeedEvThreshold(trade.netEvPercent) ? trade : null;
  }
  const tradeEvPercent = resolveWhaleTradeEvPercent(trade, pipelineEvIndex);
  if (tradeEvPercent == null || !Number.isFinite(tradeEvPercent)) return null;
  if (!meetsProductFeedEvThreshold(tradeEvPercent)) return null;
  return stampWhaleFeedAdmissionEv(trade, tradeEvPercent);
}

export function useWhaleFeed() {
  const { whaleTrades: liveSocketTrades, connected } =
    usePolymarketSocketContext();
  const { trades: kalshiFeedTrades, ok: kalshiOk } = useKalshiTrades();
  useWalletEnrichment();
  const [backfill, setBackfill] = useState<WhaleTrade[]>([]);
  const [kalshiBackfill, setKalshiBackfill] = useState<KalshiFeedTradeInput[]>(
    []
  );
  const [backfillLoaded, setBackfillLoaded] = useState(false);
  const seenHashes = useRef<Set<string>>(new Set());
  const liveDetectedAt = useRef<Map<string, number>>(new Map());
  const metricsDetected = useRef<Set<string>>(new Set());
  const metricsPassed = useRef<Set<string>>(new Set());
  const metricsFinalized = useRef<Set<string>>(new Set());
  const qualifiedNotified = useRef<Set<string>>(new Set());
  const loggedFilterRejects = useRef<Set<string>>(new Set());
  const lastVolumeSummaryKey = useRef<string>("");
  const [whaleBuffer, setWhaleBuffer] = useState<WhaleTrade[]>([]);
  const whaleBufferSeen = useRef<Set<string>>(new Set());
  const [newWhale, setNewWhale] = useState<WhaleTrade | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    let seedMarked = false;

    const markSeedLoaded = () => {
      if (seedMarked) return;
      seedMarked = true;
      setBackfillLoaded(true);
    };

    const applyBackfill = (payload: BackfillPayload) => {
      const whales = payload.polymarket
        .filter((t) =>
          meetsProductFeedEvThreshold(t.netEvPercent ?? t.averageEv)
        )
        .map((t) => ({
        ...tradeToWhale(t, {
          detectedAt: t.timestamp * 1000,
          isLive: false,
          usdNotional: resolvePolymarketTradeNotionalUsd(t),
          source: "polymarket",
        }),
        whaleIdentity: t.whaleIdentity,
        whaleAlias: t.displayName ?? t.whaleAlias,
        displayName: t.displayName ?? t.whaleAlias,
        marketTranslation: t.marketTranslation,
        netEvPercent: t.netEvPercent ?? null,
        averageEv: t.averageEv ?? t.netEvPercent ?? null,
        category: t.category,
      }));
      setBackfill((prev) => retainLastNonEmpty(whales, prev));
      if (payload.kalshi.length > 0) {
        setKalshiBackfill((prev) => {
          const merged = new Map<string, KalshiFeedTradeInput>();
          for (const trade of prev) merged.set(trade.id, trade);
          for (const trade of payload.kalshi) merged.set(trade.id, trade);
          return Array.from(merged.values());
        });

        const kalshiSeedCandidates = seedKalshiWhalesToBuffer(payload.kalshi);
        if (kalshiSeedCandidates.length > 0) {
          setWhaleBuffer((prev) => {
            const merged = prependWhaleBuffer(prev, kalshiSeedCandidates);
            for (const trade of kalshiSeedCandidates) {
              whaleBufferSeen.current.add(whaleKey(trade));
            }
            return merged;
          });
        }
      }
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

    const loadRecentSeed = async () => {
      for (let attempt = 1; attempt <= RECENT_SEED_ATTEMPTS; attempt += 1) {
        if (abort.signal.aborted) return;
        try {
          const seeded = await fetchRecentSeedTrades(abort.signal);
          if (abort.signal.aborted) return;
          if (seeded.length > 0) {
            const polymarketSeeded = seeded
              .filter((trade) => trade.source === "polymarket")
              .filter((trade) =>
                meetsProductFeedEvThreshold(trade.netEvPercent)
              );
            if (polymarketSeeded.length > 0) {
              setBackfill((prev) =>
                retainLastNonEmpty(polymarketSeeded, prev)
              );
            }

            const kalshiSeeded = seeded
              .filter((trade) => trade.source === "kalshi")
              .filter((trade) =>
                meetsProductFeedEvThreshold(trade.netEvPercent)
              )
              .map((trade) =>
                stampWhaleFeedAdmissionEv(trade, trade.netEvPercent as number)
              )
              .sort(byDetectedDesc)
              .slice(0, WHALE_FEED_SEED_LIMIT);

            if (kalshiSeeded.length > 0) {
              setWhaleBuffer((prev) => prependWhaleBuffer(prev, kalshiSeeded));
              for (const w of kalshiSeeded) {
                whaleBufferSeen.current.add(whaleKey(w));
              }
            }

            for (const w of polymarketSeeded) {
              if (w.transactionHash) seenHashes.current.add(w.transactionHash);
            }
            break;
          }
        } catch (error) {
          console.error(
            `[useWhaleFeed] /api/trades/recent attempt ${attempt}/${RECENT_SEED_ATTEMPTS} failed`,
            error instanceof Error ? error.message : error
          );
        }
        if (abort.signal.aborted) return;
        if (attempt < RECENT_SEED_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, RECENT_SEED_RETRY_DELAY_MS * attempt)
          );
        }
      }
    };

    const load = async () => {
      for (let attempt = 1; attempt <= BACKFILL_ATTEMPTS; attempt += 1) {
        if (abort.signal.aborted) return;
        try {
          const payload = await fetchBackfillTrades(abort.signal);
          if (abort.signal.aborted) return;
          applyBackfill(payload);
          if (payload.polymarket.length > 0 || payload.kalshi.length > 0) break;
        } catch (error) {
          console.error(
            `[useWhaleFeed] /api/feed attempt ${attempt}/${BACKFILL_ATTEMPTS} failed`,
            error instanceof Error ? error.message : error
          );
          if (abort.signal.aborted) return;
          if (attempt === BACKFILL_ATTEMPTS) break;
          await new Promise((resolve) =>
            setTimeout(resolve, BACKFILL_RETRY_DELAY_MS * attempt)
          );
        }
      }
    };

    const hydrate = async () => {
      try {
        await Promise.allSettled([loadRecentSeed(), load()]);
      } finally {
        markSeedLoaded();
      }
    };

    void hydrate();
    return () => abort.abort();
  }, []);

  /** Belt-and-suspenders Kalshi seed — /api/feed may return history without Kalshi. */
  useEffect(() => {
    if (!KALSHI_FEED_ENABLED) return;

    let cancelled = false;

    const seedKalshiFromApi = async () => {
      try {
        const res = await fetch("/api/kalshi/trades");
        if (!res.ok || cancelled) return;
        const data: { trades?: KalshiFeedTradeInput[] } = await res.json();
        const incoming = (data.trades ?? []).map(kalshiFeedTradeFromApi);
        if (incoming.length === 0 || cancelled) return;

        setKalshiBackfill((prev) => {
          const merged = new Map<string, KalshiFeedTradeInput>();
          for (const trade of prev) merged.set(trade.id, trade);
          for (const trade of incoming) merged.set(trade.id, trade);
          return Array.from(merged.values());
        });
      } catch {
        // Live poll via useKalshiTrades continues retrying.
      }
    };

    void seedKalshiFromApi();
    return () => {
      cancelled = true;
    };
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

  const mergedKalshiFeedTrades = useMemo(() => {
    const byId = new Map<string, KalshiFeedTradeInput>();
    for (const trade of kalshiBackfill) {
      if (trade.id) byId.set(trade.id, trade);
    }
    for (const trade of kalshiFeedTrades) {
      if (trade.id) {
        byId.set(trade.id, kalshiFeedTradeFromApi(trade as KalshiFeedTradeInput));
      }
    }
    return Array.from(byId.values());
  }, [kalshiBackfill, kalshiFeedTrades]);

  const kalshiWhales = useMemo(() => {
    if (!KALSHI_FEED_ENABLED) return [];
    return mergedKalshiFeedTrades.map((trade) => kalshiFeedTradeToWhale(trade));
  }, [mergedKalshiFeedTrades]);

  /** Pipeline EV batch includes the hydrated buffer plus live poll candidates. */
  const evTargetWhales = useMemo(
    () => [...whaleBuffer, ...polymarketWhales, ...kalshiWhales],
    [whaleBuffer, polymarketWhales, kalshiWhales]
  );

  const polymarketWalletAddresses = useMemo(
    () => collectPolymarketWalletAddresses(polymarketWhales, whaleBuffer),
    [polymarketWhales, whaleBuffer]
  );
  const walletQualifications = useQualifiedWalletFilter(polymarketWalletAddresses);
  const { index: pipelineEvIndex } = usePipelineEvForWhales(evTargetWhales);

  useEffect(() => {
    if (pipelineEvIndex.size === 0) return;
    setWhaleBuffer((prev) => {
      let changed = false;
      const next = prev.map((trade) => {
        const pipeline = resolvePipelineEvForWhale(pipelineEvIndex, trade);
        const merged = mergePipelineEvOntoWhale(trade, pipeline ?? undefined);
        if (
          merged.netEvPercent !== trade.netEvPercent ||
          merged.averageEv !== trade.averageEv
        ) {
          changed = true;
        }
        return merged;
      });
      return changed ? next : prev;
    });
  }, [pipelineEvIndex]);

  const qualifiedPolymarketWhales = useMemo(
    () =>
      polymarketWhales
        .filter((trade) =>
          passesPolymarketClientFeedAdmissionGate(
            trade,
            walletQualifications,
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
        }),
    [polymarketWhales, walletQualifications, pipelineEvIndex]
  );

  const qualifiedKalshiWhales = useMemo(
    () =>
      kalshiWhales
        .filter((trade) => {
          const logKey = `${trade.id}:kalshi`;
          const eligible = isKalshiTradeVisibleInUserFeed(trade, pipelineEvIndex, {
            id: trade.id,
            logRejection: !loggedFilterRejects.current.has(logKey),
          });
          if (!eligible) {
            loggedFilterRejects.current.add(logKey);
          }
          return eligible;
        })
        .map((trade) =>
          mergePipelineEvOntoWhale(
            trade,
            resolvePipelineEvForWhale(pipelineEvIndex, trade) ?? undefined
          )
        ),
    [kalshiWhales, pipelineEvIndex]
  );

  useEffect(() => {
    if (!backfillLoaded) return;

    const counts = summarizeFeedVolumeDrops({
      polymarketWhales,
      kalshiWhales,
      pipelineEvIndex,
      walletQualifications,
    });
    const summaryKey = [
      counts.incomingPolymarket,
      counts.incomingKalshi,
      counts.admittedPolymarket,
      counts.admittedKalshi,
      counts.stakeFloor,
      counts.evGate,
      counts.walletCredibility,
      counts.marketTranslation,
      counts.unmappedTicker,
      pipelineEvIndex.size,
    ].join(":");
    if (summaryKey === lastVolumeSummaryKey.current) return;
    lastVolumeSummaryKey.current = summaryKey;
    logFeedVolumeDiagnostics(counts);
  }, [
    backfillLoaded,
    polymarketWhales,
    kalshiWhales,
    pipelineEvIndex,
    walletQualifications,
  ]);

  useEffect(() => {
    if (!backfillLoaded) return;

    const incoming: WhaleTrade[] = [];

    for (const whale of liveWhales) {
      const key = whaleKey(whale);
      if (!key || whaleBufferSeen.current.has(key)) continue;

      if (!meetsProductFeedStakeThreshold(whale.usdNotional)) continue;

      const wallet = whale.proxyWallet?.trim().toLowerCase();
      if (
        !passesPolymarketWalletCredibilityForClient(
          wallet,
          wallet ? walletQualifications.get(wallet) : undefined
        )
      ) {
        continue;
      }

      const admitted = stampWhaleForFeedAdmission(whale, pipelineEvIndex);
      if (!admitted) continue;
      whaleBufferSeen.current.add(key);
      incoming.push(admitted);
    }

    for (const whale of qualifiedKalshiWhales) {
      const key = whaleKey(whale);
      if (!key || whaleBufferSeen.current.has(key)) continue;
      if (
        !isKalshiWhaleEligibleForLiveFeed(
          whale,
          pipelineEvIndex,
          loggedFilterRejects.current
        )
      ) {
        continue;
      }
      const admitted = stampWhaleForFeedAdmission(whale, pipelineEvIndex);
      if (!admitted) continue;
      whaleBufferSeen.current.add(key);
      incoming.push(admitted);
    }

    for (const whale of qualifiedPolymarketWhales) {
      const key = whaleKey(whale);
      if (!key || whaleBufferSeen.current.has(key)) continue;
      const admitted = stampWhaleForFeedAdmission(whale, pipelineEvIndex);
      if (!admitted) continue;
      whaleBufferSeen.current.add(key);
      incoming.push(admitted);
    }

    if (incoming.length === 0) return;

    const ordered = buildPlatformFeed(
      incoming.filter((trade) => trade.source !== "kalshi"),
      incoming.filter((trade) => trade.source === "kalshi"),
      "all",
      byDetectedDesc
    );
    setWhaleBuffer((prev) => prependWhaleBuffer(prev, ordered));
  }, [
    liveWhales,
    qualifiedKalshiWhales,
    qualifiedPolymarketWhales,
    backfillLoaded,
    pipelineEvIndex,
    walletQualifications,
  ]);

  useEffect(() => {
    if (!backfillLoaded) return;
    setWhaleBuffer((prev) => {
      const pruned = prev.filter((trade) =>
        isVisibleInClientFeed(
          trade,
          walletQualifications,
          pipelineEvIndex,
          loggedFilterRejects.current
        )
      );
      return pruned.length === prev.length ? prev : pruned;
    });
  }, [backfillLoaded, pipelineEvIndex, walletQualifications]);

  const whales = useMemo(
    () =>
      whaleBuffer.filter((trade) =>
        isVisibleInClientFeed(
          trade,
          walletQualifications,
          pipelineEvIndex,
          loggedFilterRejects.current
        )
      ),
    [whaleBuffer, walletQualifications, pipelineEvIndex]
  );

  const dismissNewWhale = useCallback(() => setNewWhale(null), []);

  useEffect(() => {
    if (!backfillLoaded) return;

    const delta = aggregatePolymarketFeedMetrics(
      liveWhales,
      walletQualifications,
      pipelineEvIndex,
      {
        metricsDetected: metricsDetected.current,
        metricsPassed: metricsPassed.current,
        metricsFinalized: metricsFinalized.current,
      },
      loggedFilterRejects.current
    );

    reportFeedMetrics({
      tradesDetected: delta.tradesDetected,
      gatePassedTrades: delta.gatePassedTrades,
      whaleWallets: delta.passedWallets,
    });
  }, [liveWhales, pipelineEvIndex, walletQualifications, backfillLoaded]);

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

      const wallet = whale.proxyWallet?.trim().toLowerCase();
      if (
        !passesPolymarketWalletCredibilityForClient(
          wallet,
          wallet ? walletQualifications.get(wallet) : undefined
        )
      ) {
        continue;
      }

      qualifiedNotified.current.add(key);
      const qualification = wallet
        ? walletQualifications.get(wallet)
        : undefined;
      const enriched = attachWhaleIdentity(whale, qualification);
      setNewWhale(enriched);
      queueWhaleTweetNotify(enriched);
    }
  }, [liveWhales, backfillLoaded, walletQualifications, pipelineEvIndex]);

  return {
    whales,
    connected,
    kalshiOk,
    backfillLoaded,
    newWhale,
    dismissNewWhale,
  };
}
