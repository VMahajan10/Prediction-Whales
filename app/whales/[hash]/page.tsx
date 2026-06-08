"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  findMarketForTrade,
  findRelatedTrades,
  findTradeByHash,
  scoreWhale,
  truncateTxHash,
} from "@/lib/whaleProfile";
import type { MarketSummary, TradeSummary } from "@/lib/polymarket";
import { formatVolumeUsd } from "@/lib/polymarket";
import { getFullDate, getTimeAgo, getUtcString } from "@/lib/time";

interface WhaleProfileResponse {
  trade: TradeSummary | null;
  relatedTrades: TradeSummary[];
  marketContext: {
    currentProbability: number | null;
    priceAtTrade: number;
    delta: number;
  };
  matchedMarket: MarketSummary | null;
  error?: string;
}

const MIN_WHALE_THRESHOLD = 500;
const NEARBY_MIN_SIZE = 100;
const US_WEEKLY_WAGE = 1154;
const BAR_UNIT = 125;

function getPlainEnglishBet(trade: TradeSummary): string {
  if (trade.side === "SELL") {
    return "they're EXITING a previous bet on this outcome";
  }
  const outcome = trade.outcome.toLowerCase();
  if (outcome === "yes") return "this WILL happen";
  if (outcome === "no") return "this WON'T happen";
  return `the outcome "${trade.outcome}" will happen`;
}

function getOddsComparison(prob: number): string {
  if (prob < 0.05) return "Getting heads 4 times in a row";
  if (prob < 0.1) return "Rolling a 1 on a dice";
  if (prob < 0.2) return "Drawing a specific suit from a deck";
  if (prob < 0.33) return "Rolling a 1 or 2 on a dice";
  if (prob < 0.5) return "Flipping heads twice in a row";
  if (prob < 0.67) return "Flipping heads once";
  if (prob < 0.85) return "Drawing a red card from a deck";
  return "Rolling anything but a 1 on a dice";
}

function getResearchAdvice(title: string): string {
  const t = title.toLowerCase();

  if (t.includes("bitcoin") || t.includes("crypto") || t.includes("ethereum")) {
    return "Check recent Bitcoin price action and macro news.";
  }
  if (t.includes("election") || t.includes("president") || t.includes("vote")) {
    return "Look up recent polls for this election.";
  }

  const countries = [
    "peru",
    "france",
    "spain",
    "brazil",
    "mexico",
    "ukraine",
    "israel",
    "china",
    "india",
    "germany",
    "uk",
    "canada",
  ];
  for (const country of countries) {
    if (t.includes(country)) {
      const name = country.charAt(0).toUpperCase() + country.slice(1);
      return `Research ${name}'s political situation and recent news.`;
    }
  }

  const nameMatch = title.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/
  );
  if (nameMatch) {
    return `Research ${nameMatch[1]}'s recent performance and injury status.`;
  }

  return "Research the specific event and form your own view.";
}

function getTopPercentTier(size: number): string {
  if (size > 10000) return "1";
  if (size > 5000) return "5";
  return "10";
}

function getTimingAnalysis(timestamp: number): string {
  const hour = new Date(timestamp * 1000).getHours();
  if (hour >= 22 || hour <= 6) {
    return "⏰ Late night trade (after hours). Trades placed outside market hours sometimes indicate reaction to breaking news or overseas events.";
  }
  if (hour >= 9 && hour <= 16) {
    return "⏰ Business hours trade. Normal trading window — no unusual timing signals.";
  }
  return "⏰ Evening trade. Common for retail traders after work hours.";
}

function getMarketVolumeContext(
  size: number,
  volume: number
): { pct: number; message: string } | null {
  if (volume <= 0) return null;
  const pct = (size / volume) * 100;
  let message: string;
  if (pct > 1) {
    message =
      "That's significant — this one trade moved the market. When a single bet is >1% of total volume, it often shifts the price.";
  } else if (pct > 0.1) {
    message =
      "Meaningful but not market-moving. This whale is a notable participant.";
  } else {
    message =
      "Small relative to total market size. This whale is one of many.";
  }
  return { pct, message };
}

function BarComparison({
  label,
  amount,
  filled,
}: {
  label: string;
  amount: string;
  filled: number;
}) {
  return (
    <div className="mb-2">
      <div className="mb-1 flex justify-between text-xs text-slate-400">
        <span>{label}</span>
        <span>{amount}</span>
      </div>
      <div className="flex gap-1">
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className={`h-3 flex-1 rounded-sm ${
              i < filled ? "bg-pulse-accent" : "bg-slate-700"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function StatBox({
  value,
  label,
  explain,
  valueClassName = "text-white",
}: {
  value: string;
  label: string;
  explain: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
      <p className={`text-xl font-bold ${valueClassName}`}>{value}</p>
      <p className="mb-2 text-xs font-medium text-slate-300">{label}</p>
      <p className="text-xs leading-relaxed text-slate-400">{explain}</p>
    </div>
  );
}

export default function WhaleProfilePage() {
  const params = useParams();
  const hash = typeof params.hash === "string" ? params.hash : "";

  const [trade, setTrade] = useState<TradeSummary | null>(null);
  const [relatedTrades, setRelatedTrades] = useState<TradeSummary[]>([]);
  const [matchedMarket, setMatchedMarket] = useState<MarketSummary | null>(
    null
  );
  const [marketContext, setMarketContext] = useState<
    WhaleProfileResponse["marketContext"]
  >({
    currentProbability: null,
    priceAtTrade: 0,
    delta: 0,
  });
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [showAllNearby, setShowAllNearby] = useState(false);

  const loadProfile = useCallback(async () => {
    if (!hash) return;

    try {
      const [tradesRes, profileRes, pmRes, piRes] = await Promise.all([
        fetch("/api/trades"),
        fetch(`/api/whale-profile?hash=${encodeURIComponent(hash)}`),
        fetch("/api/markets"),
        fetch("/api/kalshi"),
      ]);

      const tradesData: { trades?: TradeSummary[] } = await tradesRes.json();
      const profileData: WhaleProfileResponse = await profileRes.json();
      const pmData: { markets?: MarketSummary[] } = await pmRes.json();
      const piData: { markets?: MarketSummary[] } = await piRes.json();

      const trades = tradesData.trades ?? [];
      const allMarkets = [
        ...(pmData.markets ?? []),
        ...(piData.markets ?? []),
      ];

      const foundTrade =
        findTradeByHash(trades, hash) ?? profileData.trade ?? null;

      if (!foundTrade) {
        setNotFound(true);
        setTrade(null);
        return;
      }

      setTrade(foundTrade);
      const nearby = findRelatedTrades(trades, foundTrade);
      setRelatedTrades(
        nearby.length > 0 ? nearby : profileData.relatedTrades
      );

      const market =
        profileData.matchedMarket ??
        findMarketForTrade(foundTrade, allMarkets);
      setMatchedMarket(market);
      setMarketContext(
        profileData.marketContext ?? {
          currentProbability: market?.probability ?? null,
          priceAtTrade: foundTrade.price,
          delta:
            market != null
              ? (market.probability - foundTrade.price) * 100
              : 0,
        }
      );
      setNotFound(false);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [hash]);

  useEffect(() => {
    setLoading(true);
    loadProfile();
  }, [loadProfile]);

  const whaleScore = useMemo(
    () => (trade ? scoreWhale(trade) : null),
    [trade]
  );

  const filteredNearby = useMemo(() => {
    return relatedTrades
      .filter((t) => t.size >= NEARBY_MIN_SIZE)
      .sort((a, b) => b.size - a.size);
  }, [relatedTrades]);

  const visibleNearby = showAllNearby
    ? filteredNearby
    : filteredNearby.slice(0, 5);

  if (loading) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <p className="text-pulse-muted animate-pulse">Loading whale profile…</p>
      </main>
    );
  }

  if (notFound || !trade || !whaleScore) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Link href="/" className="text-sm text-pulse-accent hover:underline">
          ← Back to Dashboard
        </Link>
        <p className="mt-8 text-red-400">Whale trade not found.</p>
      </main>
    );
  }

  const price = trade.price;
  const priceCents = (price * 100).toFixed(1);
  const probPct = (price * 100).toFixed(1);
  const size = trade.size;
  const shares = price > 0 ? size / price : 0;
  const payout = shares;
  const profit = payout - size;
  const profitPct = size > 0 ? ((profit / size) * 100).toFixed(1) : "0";
  const multiplier = price > 0 ? (1 / price).toFixed(1) : "—";
  const salaryWeeks = Math.round(size / US_WEEKLY_WAGE);
  const sizeMultiple = (size / MIN_WHALE_THRESHOLD).toFixed(1);
  const topPercent = getTopPercentTier(size);
  const filledCircles = Math.round(price * 10);
  const whaleImpliedProb = Math.min(price + 0.1, 0.99);
  const whaleEv = whaleImpliedProb * payout - size;
  const loseOutOf10 = Math.round((1 - price) * 10);
  const avgBars = Math.min(10, Math.max(1, Math.round(MIN_WHALE_THRESHOLD / BAR_UNIT)));
  const tradeBars = Math.min(10, Math.max(1, Math.round(size / BAR_UNIT)));
  const volumeContext = matchedMarket
    ? getMarketVolumeContext(size, matchedMarket.volume)
    : null;
  const researchAdvice = getResearchAdvice(trade.title);
  const plainBet = getPlainEnglishBet(trade);
  const oddsComparison = getOddsComparison(price);
  const timingAnalysis = getTimingAnalysis(trade.timestamp);

  const verdictPositives: string[] = [];
  const verdictCautions: string[] = [];

  if (size >= 1000) {
    verdictPositives.push(
      `$${size.toLocaleString()} is serious money — not a casual bet`
    );
  } else {
    verdictPositives.push(
      `$${size.toLocaleString()} exceeds the whale threshold — worth noting`
    );
  }

  if (trade.side === "BUY" && price < 0.5) {
    verdictPositives.push(
      `Buying the underdog at ${probPct}% suggests the whale believes the crowd is wrong`
    );
  } else if (trade.side === "BUY") {
    verdictPositives.push(
      `Buying at ${probPct}% shows conviction in a likely outcome`
    );
  } else {
    verdictCautions.push(
      "This is a SELL — could be profit-taking rather than a new conviction bet"
    );
  }

  if (price < 0.5) {
    verdictCautions.push(
      `${probPct}% is still a longshot — this whale will lose this bet ${loseOutOf10} out of 10 times`
    );
  }

  verdictCautions.push(
    "We can't verify if this is informed trading or just a large gamble"
  );

  const outcomeSubject =
    trade.outcome.toLowerCase() === "yes" || trade.outcome.toLowerCase() === "no"
      ? trade.title
      : trade.outcome;

  return (
    <main className="mx-auto min-h-screen max-w-4xl px-4 py-8 sm:px-6">
      <Link
        href="/"
        className="mb-6 inline-block text-sm text-pulse-muted transition-colors hover:text-white"
      >
        ← Back to Dashboard
      </Link>

      {/* SECTION 1: WHALE IDENTITY */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          🐋 Whale Identity
        </h2>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
              Wallet Fingerprint
            </p>
            <p className="font-mono text-lg font-semibold text-white">
              {truncateTxHash(trade.transactionHash)}
            </p>
            <p className="mt-1 break-all font-mono text-xs text-slate-500">
              {trade.transactionHash}
            </p>
            <a
              href={`https://polygonscan.com/tx/${trade.transactionHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block text-sm text-pulse-accent hover:underline"
            >
              View on blockchain →
            </a>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              Think of this like a license plate — every trade on Polymarket is
              tied to a wallet address. We use the transaction hash as a unique
              fingerprint for this trade.
            </p>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
              Trade Timestamp
            </p>
            <p className="text-lg font-semibold text-white">
              {getFullDate(trade.timestamp)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              UTC: {getUtcString(trade.timestamp)}
            </p>
            <p className="mt-1 text-sm text-pulse-accent">
              {getTimeAgo(trade.timestamp)}
            </p>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              The exact moment this whale pulled the trigger. Timing matters —
              trades right before major news often signal inside knowledge.
            </p>
          </div>
        </div>
      </section>

      {/* SECTION 2: WHAT HAPPENED */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          📖 What Happened — In Plain English
        </h2>
        <div className="space-y-3 text-sm leading-relaxed text-slate-300">
          <p>
            At {getTimeAgo(trade.timestamp)}, someone placed a{" "}
            <strong className="text-white">
              ${size.toLocaleString()}
            </strong>{" "}
            {trade.side === "SELL" ? "sell order on" : "bet that"}{" "}
            <strong className="text-white">{trade.outcome}</strong> on &ldquo;
            {trade.title}&rdquo;.
          </p>
          <p>
            They paid <strong className="text-white">{priceCents}¢</strong> per
            share, which means they{" "}
            {trade.side === "SELL" ? "sold" : "bought"}{" "}
            <strong className="text-white">
              {Math.round(shares).toLocaleString()}
            </strong>{" "}
            shares total.
          </p>
          <p>
            In simple terms:{" "}
            {trade.side === "SELL" ? (
              <>
                they&apos;re <strong className="text-white">exiting</strong> a
                position on this market.
              </>
            ) : (
              <>
                they&apos;re betting{" "}
                <strong className="text-white">
                  ${size.toLocaleString()}
                </strong>{" "}
                that <strong className="text-white">{plainBet}</strong>.
              </>
            )}
          </p>
          {trade.side === "BUY" && (
            <p>
              If they&apos;re right, they&apos;ll collect{" "}
              <strong className="text-pulse-yes">
                ${payout.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </strong>{" "}
              — a profit of{" "}
              <strong className="text-pulse-yes">
                ${profit.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </strong>{" "}
              ({profitPct}% return). If they&apos;re wrong, they lose their
              entire ${size.toLocaleString()}.
            </p>
          )}
        </div>
      </section>

      {/* SECTION 3: MONEY MATH */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          💰 Breaking Down the Money
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <StatBox
            value={`$${size.toLocaleString()}`}
            label="Money at stake"
            explain={`This is real money on the line. $${size.toLocaleString()} is roughly ${salaryWeeks} weeks of average US salary. This person is serious.`}
          />
          <StatBox
            value={`${priceCents}¢ per share`}
            label="Cost per share"
            explain={`Each share costs ${priceCents}¢. If the market resolves YES, each share pays $1.00. That's a ${multiplier}x return on each dollar spent.`}
          />
          <StatBox
            value={`${Math.round(shares).toLocaleString()} shares`}
            label="Shares purchased"
            explain={`Like buying ${Math.round(shares).toLocaleString()} lottery tickets that each pay $1 if you win. The more shares, the bigger the position.`}
          />
          <StatBox
            value={`$${payout.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
            label="If they win"
            valueClassName="text-pulse-yes"
            explain={`This is what they collect if correct. That's a $${profit.toLocaleString(undefined, { maximumFractionDigits: 0 })} profit on a $${size.toLocaleString()} bet — a ${profitPct}% return if the market resolves YES.`}
          />
        </div>
      </section>

      {/* SECTION 4: PROBABILITY */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          🎯 What Does {probPct}% Actually Mean?
        </h2>
        <p className="mb-4 text-sm text-slate-300">
          The market currently prices this at {probPct}%. Here&apos;s what that
          means in real terms:
        </p>
        <div className="mb-4 flex gap-1">
          {Array.from({ length: 10 }).map((_, i) => (
            <span key={i} className="text-lg">
              {i < filledCircles ? "🟢" : "⬜"}
            </span>
          ))}
        </div>
        <p className="mb-4 text-sm text-slate-300">
          {filledCircles} out of 10 people think{" "}
          <strong className="text-white">{outcomeSubject}</strong> will happen
        </p>
        <div className="mb-4 rounded-lg bg-slate-900/60 p-4 text-sm text-slate-300">
          <p className="mb-1 font-medium text-white">Odds comparison</p>
          <p>
            {probPct}% is roughly the same odds as:{" "}
            <strong className="text-white">{oddsComparison}</strong>
          </p>
        </div>
        <div className="text-sm leading-relaxed text-slate-300">
          <p className="mb-3">
            By placing this bet, the whale is signaling they believe the TRUE
            probability is <strong className="text-white">HIGHER</strong> than{" "}
            {probPct}%. They think the market is underpricing this outcome.
          </p>
          <p>
            If they think the real probability is even{" "}
            {(whaleImpliedProb * 100).toFixed(0)}%, this bet has positive
            expected value:
          </p>
          <p className="mt-2 font-mono text-slate-200">
            EV = ({(whaleImpliedProb * 100).toFixed(0)}% × $
            {payout.toLocaleString(undefined, { maximumFractionDigits: 0 })}) -
            ${size.toLocaleString()} ={" "}
            <span className={whaleEv >= 0 ? "text-pulse-yes" : "text-red-400"}>
              {whaleEv >= 0 ? "+" : ""}$
              {whaleEv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          </p>
        </div>
      </section>

      {/* SECTION 5: CONVICTION SIGNALS */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          🔍 Reading the Signals
        </h2>
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-3 text-sm font-medium text-white">
              Signal 1 — Position Size Context
            </p>
            <BarComparison
              label="Average whale trade"
              amount={`$${MIN_WHALE_THRESHOLD}`}
              filled={avgBars}
            />
            <BarComparison
              label="This trade"
              amount={`$${size.toLocaleString()}`}
              filled={tradeBars}
            />
            <p className="mt-2 text-sm text-slate-400">
              ${size.toLocaleString()} is {sizeMultiple}x larger than the
              minimum whale threshold (${MIN_WHALE_THRESHOLD}). This puts it in
              the top {topPercent}% of all trades on this platform.
            </p>
          </div>

          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-2 text-sm font-medium text-white">
              Signal 2 — Price Entry Analysis
            </p>
            <p className="text-sm leading-relaxed text-slate-400">
              This whale {trade.side === "SELL" ? "sold" : "bought"} at{" "}
              {priceCents}¢.
              {price < 0.5 ? (
                <>
                  {" "}
                  Buying below 50¢ means betting on an UNDERDOG. Underdogs pay
                  more if they win ({multiplier}x here) but lose more often.
                  Smart money often bets underdogs when they believe the crowd
                  is wrong. The question is: does this whale know something the
                  market doesn&apos;t?
                </>
              ) : (
                <>
                  {" "}
                  Buying above 50¢ means betting on a FAVORITE. Favorites win
                  more often but pay less. This whale is paying a premium for a
                  higher-probability outcome.
                </>
              )}
            </p>
          </div>

          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-2 text-sm font-medium text-white">
              Signal 3 — BUY vs SELL Meaning
            </p>
            <p className="text-sm leading-relaxed text-slate-400">
              {trade.side === "BUY"
                ? "A BUY order means this whale is OPENING a new position — they're putting fresh money in. This is more meaningful than a SELL, which could just be someone cashing out an existing bet."
                : "A SELL order means this whale is CLOSING or reducing an existing position. They might be taking profit, cutting losses, or hedging. Less bullish than a BUY signal."}
            </p>
          </div>

          {volumeContext && matchedMarket && (
            <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
              <p className="mb-2 text-sm font-medium text-white">
                Signal 4 — Market Significance
              </p>
              <p className="text-sm leading-relaxed text-slate-400">
                This market has {formatVolumeUsd(matchedMarket.volume)} in
                total trading. This whale&apos;s ${size.toLocaleString()}{" "}
                represents {volumeContext.pct.toFixed(2)}% of all money bet on
                this market. {volumeContext.message}
              </p>
            </div>
          )}

          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-2 text-sm font-medium text-white">
              Signal 5 — Timing Analysis
            </p>
            <p className="text-sm leading-relaxed text-slate-400">
              {timingAnalysis}
            </p>
          </div>
        </div>
      </section>

      {/* SECTION 6: VERDICT */}
      <section className="mb-8 rounded-xl border-2 border-yellow-500/40 bg-slate-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          ⚖️ The Verdict — Should You Pay Attention?
        </h2>
        <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-5">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
            Our Assessment
          </p>
          <p className="mb-4 text-xl font-bold text-white">
            {whaleScore.verdict.toUpperCase()} {whaleScore.emoji}
          </p>
          <p className="mb-4 text-sm font-medium text-slate-300">
            Here&apos;s exactly why:
          </p>
          <ul className="mb-4 space-y-2 text-sm">
            {verdictPositives.map((item) => (
              <li key={item} className="text-pulse-yes">
                ✅ {item}
              </li>
            ))}
            {verdictCautions.map((item) => (
              <li key={item} className="text-yellow-400">
                ⚠️ {item}
              </li>
            ))}
          </ul>
          <div className="rounded-lg bg-slate-800 p-4">
            <p className="mb-2 text-sm font-medium text-white">💡 What to do:</p>
            <p className="text-sm text-slate-300">{researchAdvice}</p>
            {matchedMarket && (
              <Link
                href={`/markets/${matchedMarket.id}`}
                className="mt-3 inline-block text-sm text-pulse-accent hover:underline"
              >
                View the full market →
              </Link>
            )}
          </div>
          <p className="mt-4 text-xs text-slate-500">
            Never bet more than you can afford to lose entirely.
          </p>
        </div>
      </section>

      {/* SECTION 7: NEARBY TRADES */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          🔗 Other Activity at the Same Time
        </h2>
        {filteredNearby.length === 0 ? (
          <p className="text-sm text-slate-400">
            All other nearby trades were under ${NEARBY_MIN_SIZE} — likely
            unrelated retail activity. Focus on the main trade above.
          </p>
        ) : (
          <>
            <div className="space-y-3">
              {visibleNearby.map((t) => (
                <div
                  key={t.id}
                  className="rounded-xl border border-slate-700 bg-slate-900/50 p-4"
                >
                  <p className="font-medium text-white">{t.title}</p>
                  <p className="mb-2 text-sm text-slate-400">
                    {t.side} · ${Math.round(t.size).toLocaleString()} ·{" "}
                    {(t.price * 100).toFixed(1)}¢
                  </p>
                  <p className="text-xs italic text-slate-500">
                    A separate ${Math.round(t.size).toLocaleString()} bet placed
                    at nearly the same time. Could be the same wallet
                    diversifying, or a different trader entirely.
                  </p>
                </div>
              ))}
            </div>
            {filteredNearby.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAllNearby((v) => !v)}
                className="mt-4 text-sm text-pulse-accent hover:underline"
              >
                {showAllNearby
                  ? "Show less"
                  : `Show ${filteredNearby.length - 5} more`}
              </button>
            )}
          </>
        )}
      </section>

      {/* SECTION 8: DISCLAIMER */}
      <section className="rounded-xl border border-slate-700 bg-slate-900/30 p-6">
        <h2 className="mb-4 text-sm font-semibold text-slate-400">
          ⚠️ Important: What We Don&apos;t Know
        </h2>
        <p className="mb-3 text-sm text-slate-400">
          Prediction market data has real limits. Here&apos;s what we CAN&apos;T
          tell you:
        </p>
        <ul className="mb-4 space-y-2 text-sm text-slate-500">
          <li>❓ Who this whale is — wallets are anonymous</li>
          <li>
            ❓ Why they placed this bet — no explanation is ever given
          </li>
          <li>
            ❓ Whether they have inside information — we can&apos;t verify this
          </li>
          <li>❓ Their track record — we only see this trade</li>
          <li>
            ❓ Whether this is their only position — they may be hedging a larger
            bet elsewhere
          </li>
        </ul>
        <p className="text-xs text-slate-500">
          Use this analysis as a starting point for your own research, never as
          the final word.
        </p>
      </section>
    </main>
  );
}
