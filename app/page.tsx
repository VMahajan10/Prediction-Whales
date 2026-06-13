"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import BeginnerGuide from "@/components/BeginnerGuide";
import MarketFeed from "@/components/MarketFeed";
import MarketMovers from "@/components/MarketMovers";
import NewWhaleToast from "@/components/NewWhaleToast";
import TradesFeed from "@/components/TradesFeed";
import WelcomeBanner from "@/components/WelcomeBanner";
import WhaleTracker from "@/components/WhaleTracker";
import { getExplorerMode, setExplorerMode } from "@/lib/explorer";
import { fetchMarketProbabilities } from "@/lib/marketPrices";
import { getPortfolio, getPortfolioStats } from "@/lib/portfolio";
import type { MarketSummary } from "@/lib/polymarket";
import {
  getWhaleSoundEnabled,
  setWhaleSoundEnabled,
  useWhaleAlerts,
} from "@/lib/useWhaleAlerts";
import { useWhaleFeed } from "@/lib/useWhaleFeed";
import { PolymarketSocketProvider } from "@/lib/PolymarketSocketProvider";

const POLYMARKET_REFRESH_MS = 10_000;
const KALSHI_REFRESH_MS = 120_000;

export default function Home() {
  return (
    <PolymarketSocketProvider>
      <HomeDashboard />
    </PolymarketSocketProvider>
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
  const { whales, connected, newWhale, dismissNewWhale } = useWhaleFeed();

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
    <main className="mx-auto min-h-screen max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-10 border-b border-pulse-border pb-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-pulse-accent/20">
              <span className="text-xl font-bold text-pulse-accent">M</span>
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
                MarketPulse
              </h1>
              <p className="text-sm text-pulse-muted">
                {explorerMode
                  ? "Explorer Mode · Learn prediction markets"
                  : "Polymarket intelligence dashboard · live WebSocket feed"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={toggleExplorerMode}
              className="rounded-lg border border-blue-500/40 bg-slate-800 px-4 py-2 text-sm font-medium text-white transition-colors hover:border-blue-400 hover:bg-slate-700"
            >
              {explorerMode
                ? "📊 Switch to Trader Mode"
                : "🎓 Explorer Mode"}
            </button>
            <Link
              href="/portfolio"
              className="rounded-lg border border-pulse-border bg-pulse-card/60 px-4 py-2 text-sm font-medium text-white transition-colors hover:border-slate-500"
            >
              💼 ${portfolioTotal.toFixed(2)}
            </Link>
          </div>
        </div>
      </header>

      {explorerMode && <WelcomeBanner />}
      {explorerMode && <BeginnerGuide />}

      <div className="grid gap-8 lg:grid-cols-3">
        <section className="lg:col-span-2">
          {!explorerMode && pmMarkets.length > 0 && (
            <div className="mb-8">
              <h2 className="mb-4 text-lg font-semibold text-white">
                🔥 Market Movers (1h)
              </h2>
              <div className="rounded-xl border border-pulse-border bg-pulse-card/40 p-4">
                <MarketMovers markets={pmMarkets} />
              </div>
            </div>
          )}

          {!explorerMode && (
            <WhaleTracker
              whales={whales}
              connected={connected}
              soundEnabled={soundEnabled}
              onToggleSound={toggleSound}
            />
          )}

          {!explorerMode && (
            <NewWhaleToast whale={newWhale} onDismiss={dismissNewWhale} />
          )}

          <section id="market-feed" className="mb-8">
            <h2 className="mb-4 text-lg font-semibold text-white">
              ⚡ Polymarket · Prediction Markets
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

          <div className="my-8 border-t border-pulse-border" />

          <section>
            <h2 className="mb-4 text-lg font-semibold text-white">
              📈 Kalshi Markets
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
        </section>

        <aside className="lg:col-span-1">
          <div className="rounded-xl border border-pulse-border bg-pulse-card/40 p-4">
            <TradesFeed />
          </div>
        </aside>
      </div>
    </main>
  );
}
