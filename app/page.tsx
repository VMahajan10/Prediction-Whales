"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import BeginnerGuide from "@/components/BeginnerGuide";
import DemoLogoutButton from "@/components/DemoLogoutButton";
import MarketFeed from "@/components/MarketFeed";
import MarketMovers from "@/components/MarketMovers";
import MobileAppShell from "@/components/MobileAppShell";
import NewWhaleToast from "@/components/NewWhaleToast";
import TradesFeed from "@/components/TradesFeed";
import WelcomeBanner from "@/components/WelcomeBanner";
import WhaleTracker from "@/components/WhaleTracker";
import { LiveFeedPlatformProvider } from "@/lib/LiveFeedPlatformContext";
import { getExplorerMode, setExplorerMode } from "@/lib/explorer";
import { fetchMarketProbabilities } from "@/lib/marketPrices";
import { getPortfolio, getPortfolioStats } from "@/lib/portfolio";
import { useBookmarkedTraders } from "@/lib/useBookmarkedTraders";
import type { MarketSummary } from "@/lib/polymarket";
import {
  getWhaleSoundEnabled,
  setWhaleSoundEnabled,
  useWhaleAlerts,
} from "@/lib/useWhaleAlerts";
import { useWhaleFeed } from "@/lib/useWhaleFeed";

const POLYMARKET_REFRESH_MS = 10_000;
const KALSHI_REFRESH_MS = 120_000;

export default function Home() {
  return (
    <LiveFeedPlatformProvider>
      <HomeDashboard />
    </LiveFeedPlatformProvider>
  );
}

function HomeDashboard() {
  const [pmMarkets, setPmMarkets] = useState<MarketSummary[]>([]);
  const [kalshiMarkets, setKalshiMarkets] = useState<MarketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [kalshiLoading, setKalshiLoading] = useState(true);
  const [pmError, setPmError] = useState<string | null>(null);
  const [kalshiError, setKalshiError] = useState<string | null>(null);
  const [kalshiLastUpdated, setKalshiLastUpdated] = useState<Date | null>(
    null
  );
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [portfolioTotal, setPortfolioTotal] = useState(1000);
  const [explorerMode, setExplorerModeState] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const { whales, connected, kalshiOk, newWhale, dismissNewWhale } =
    useWhaleFeed();
  const { bookmarkCount } = useBookmarkedTraders();

  useEffect(() => {
    setExplorerModeState(getExplorerMode());
    setSoundEnabled(getWhaleSoundEnabled());
  }, []);

  useWhaleAlerts(newWhale, dismissNewWhale);

  const toggleSound = useCallback(() => {
    const next = !getWhaleSoundEnabled();
    setWhaleSoundEnabled(next);
    setSoundEnabled(next);
  }, []);

  function toggleExplorerMode() {
    const next = !explorerMode;
    setExplorerModeState(next);
    setExplorerMode(next);
  }

  const refreshPortfolioTotal = useCallback(async () => {
    const portfolio = getPortfolio();
    const probabilities = await fetchMarketProbabilities();
    const stats = getPortfolioStats(portfolio, probabilities);
    setPortfolioTotal(stats.totalValue);
  }, []);

  const loadPolymarket = useCallback(async () => {
    try {
      const res = await fetch("/api/markets");
      const data: { markets?: MarketSummary[]; error?: string } =
        await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Failed to load Polymarket markets");
      }

      setPmMarkets(data.markets ?? []);
      setPmError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setPmError(
        err instanceof Error ? err.message : "Polymarket fetch failed"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const loadKalshi = useCallback(async () => {
    try {
      const res = await fetch("/api/kalshi");
      const data: { markets?: MarketSummary[]; error?: string } =
        await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Failed to load Kalshi markets");
      }

      setKalshiMarkets(data.markets ?? []);
      setKalshiError(null);
      setKalshiLastUpdated(new Date());
    } catch (err) {
      setKalshiError(
        err instanceof Error ? err.message : "Kalshi fetch failed"
      );
    } finally {
      setKalshiLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPolymarket();
    const interval = setInterval(loadPolymarket, POLYMARKET_REFRESH_MS);
    return () => clearInterval(interval);
  }, [loadPolymarket]);

  useEffect(() => {
    loadKalshi();
    const interval = setInterval(loadKalshi, KALSHI_REFRESH_MS);
    return () => clearInterval(interval);
  }, [loadKalshi]);

  useEffect(() => {
    refreshPortfolioTotal();
  }, [refreshPortfolioTotal]);

  return (
    <MobileAppShell showNav={!explorerMode}>
      <main className="min-h-screen px-4 py-5">
        <header className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-pulse-border bg-pulse-card">
              <span className="text-sm font-bold text-pulse-accent">M</span>
            </div>
            <div>
              <p className="text-sm font-bold text-white">Prediction Market</p>
              <p className="text-[10px] uppercase tracking-wide text-pulse-label">
                Whale intelligence
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <DemoLogoutButton />
            <button
              type="button"
              onClick={toggleExplorerMode}
              className="rounded-full border border-pulse-border bg-pulse-card px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-pulse-muted hover:text-white"
            >
              {explorerMode ? "Trader" : "Learn"}
            </button>
          </div>
        </header>

        {explorerMode && <WelcomeBanner />}
        {explorerMode && <BeginnerGuide />}

        {!explorerMode && (
          <>
            <WhaleTracker
              whales={whales}
              connected={connected}
              kalshiOk={kalshiOk}
              soundEnabled={soundEnabled}
              onToggleSound={toggleSound}
            />
            <NewWhaleToast whale={newWhale} onDismiss={dismissNewWhale} />

            <div className="mt-6 border-t border-pulse-border pt-4">
              <button
                type="button"
                onClick={() => setShowMore((v) => !v)}
                className="flex w-full items-center justify-between rounded-pulse border border-pulse-border bg-pulse-card px-4 py-3 text-left text-sm font-semibold text-white"
              >
                <span>More markets & live trades</span>
                <span className="text-pulse-accent">{showMore ? "−" : "+"}</span>
              </button>
            </div>

            {showMore && (
              <div className="mt-4 space-y-6">
                {pmMarkets.length > 0 && (
                  <section>
                    <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-white">
                      Market Movers
                    </h2>
                    <div className="pulse-card p-3">
                      <MarketMovers markets={pmMarkets} />
                    </div>
                  </section>
                )}

                <section>
                  <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-white">
                    Polymarket
                  </h2>
                  <MarketFeed
                    markets={pmMarkets}
                    loading={loading}
                    error={pmError}
                    lastUpdated={lastUpdated}
                    onRetry={() => {
                      setLoading(true);
                      loadPolymarket();
                    }}
                    explorerMode={explorerMode}
                  />
                </section>

                <section>
                  <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-white">
                    Kalshi
                  </h2>
                  <MarketFeed
                    markets={kalshiMarkets}
                    loading={kalshiLoading}
                    error={kalshiError}
                    lastUpdated={kalshiLastUpdated}
                    onRetry={() => {
                      setKalshiLoading(true);
                      loadKalshi();
                    }}
                    explorerMode={explorerMode}
                  />
                </section>

                <section>
                  <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-white">
                    Live Trades
                  </h2>
                  <div className="pulse-card p-3">
                    <TradesFeed />
                  </div>
                </section>
              </div>
            )}
          </>
        )}

        {explorerMode && (
          <div className="mt-8 space-y-6">
            <Link
              href="/following"
              className="block rounded-pulse border border-pulse-border bg-pulse-card px-4 py-3 text-sm font-semibold text-white"
            >
              ⭐ Watchlist{bookmarkCount > 0 ? ` (${bookmarkCount})` : ""}
            </Link>
            <Link
              href="/portfolio"
              className="block rounded-pulse border border-pulse-border bg-pulse-card px-4 py-3 text-sm font-semibold text-white"
            >
              💼 Portfolio · ${portfolioTotal.toFixed(2)}
            </Link>
          </div>
        )}
      </main>
    </MobileAppShell>
  );
}
