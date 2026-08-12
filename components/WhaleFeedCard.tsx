"use client";

import Link from "next/link";
import {
  categoryBadgeClass,
  inferCategoryBadge,
} from "@/lib/marketCategory";
import { formatFeedRecency } from "@/lib/constants/categories";
import { formatPriceCents, formatStakeCompact } from "@/lib/whaleDetails";
import { resolveFeedTradeEvDisplay } from "@/lib/feedTradeEv";
import {
  formatWhaleWinRatePercent,
  getUniqueTraderName,
  isAnonymousWalletAddress,
  isStaticTraderFallbackLabel,
  whaleInitialsFromPseudonym,
} from "@/lib/whaleIdentityResolver";
import { KALSHI_TRADER_ALIAS } from "@/lib/trades/whaleAliasConstants";
import type { WhaleTrade } from "@/lib/whaleTrades";

export interface WhaleFeedCardProps {
  trade: WhaleTrade;
  now: number;
  detailHref: string | null;
  onNavigate?: () => void;
  currentPrice?: number;
}

/**
 * Kalshi exposes no persistent trader identity and profiling members is
 * prohibited, so Kalshi rows show a generic trader badge in the same slot
 * (docs/Kalshi Whale Attribution Audit.md). Never a pseudonym or win rate.
 */
const KALSHI_ANONYMOUS_LABEL = KALSHI_TRADER_ALIAS;

function resolveFeedWhaleIdentity(trade: WhaleTrade) {
  if (trade.source === "kalshi") {
    return {
      pseudonym: trade.whaleAlias ?? KALSHI_ANONYMOUS_LABEL,
      initials: null,
      winRate: null,
      anonymous: true as const,
    };
  }

  const wallet = trade.proxyWallet?.trim();
  const hasWallet = Boolean(wallet && !isAnonymousWalletAddress(wallet));
  const displayName = getUniqueTraderName({
    proxyWallet: trade.proxyWallet,
    address: trade.proxyWallet,
    id: trade.id,
    transactionHash: trade.transactionHash,
    pseudonym: trade.whaleIdentity?.pseudonym,
    whaleAlias: trade.whaleAlias,
    displayName: trade.displayName,
  });
  const identity = trade.whaleIdentity;
  const anonymous =
    !hasWallet || isStaticTraderFallbackLabel(displayName);

  return {
    pseudonym: displayName,
    initials:
      identity?.initials ?? whaleInitialsFromPseudonym(displayName),
    winRate: identity?.winRate ?? null,
    anonymous,
  };
}

/** Default avatar for rows with no attributable trader. */
function AnonymousTraderIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function StatCell({
  label,
  value,
  sublabel,
  valueClass = "text-white",
}: {
  label: string;
  value: string;
  sublabel?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl bg-pulse-surface/80 px-3 py-2.5">
      <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-label">
        {label}
      </p>
      <p className={`mt-1 text-base font-bold ${valueClass}`}>{value}</p>
      {sublabel ? (
        <p className="mt-0.5 text-[8px] font-semibold uppercase tracking-wide text-pulse-label">
          {sublabel}
        </p>
      ) : null}
    </div>
  );
}

export default function WhaleFeedCard({
  trade,
  now,
  detailHref,
  onNavigate,
  currentPrice,
}: WhaleFeedCardProps) {
  const isKalshi = trade.source === "kalshi";
  const isBuy = isKalshi ? trade.outcome === "Yes" : trade.side === "BUY";
  const category = inferCategoryBadge(trade.title);
  const platform = isKalshi ? "Kalshi" : "Polymarket";
  const whale = resolveFeedWhaleIdentity(trade);
  const entryPrice = trade.price;
  const nowPrice = currentPrice ?? entryPrice;
  const recency = formatFeedRecency(trade.detectedAt, now);

  const winRateLabel = formatWhaleWinRatePercent(whale.winRate);

  const tradeEvDisplay = resolveFeedTradeEvDisplay({
    price: trade.price,
    source: trade.source,
    netEvPercent: trade.netEvPercent ?? null,
    grossEvPercent: trade.grossEvPercent ?? null,
    averageEv: trade.averageEv ?? null,
  });
  const tradeEvStatLabel = tradeEvDisplay.label;
  const tradeEvLabel = tradeEvDisplay.value;
  const tradeEvClass = tradeEvDisplay.positive
    ? "text-pulse-yes"
    : tradeEvDisplay.negative
      ? "text-pulse-no"
      : "text-pulse-label";

  const priceMovedAgainst =
    isBuy ? nowPrice < entryPrice - 0.005 : nowPrice > entryPrice + 0.005;
  const nowPriceClass = priceMovedAgainst ? "text-pulse-no" : "text-white";

  const backingLabel =
    trade.marketTranslation?.backingLabel ??
    (isBuy ? `Backing ${trade.outcome}` : "Exiting position");
  const exitLabel = trade.marketTranslation?.exitByLabel;
  const positionLabel =
    isKalshi && trade.selectionLabel
      ? trade.selectionLabel
      : (exitLabel ?? backingLabel);
  const directionClass = isBuy
    ? "bg-pulse-yes/15 text-pulse-yes"
    : "bg-pulse-no/15 text-pulse-no";

  const sideLabel = isKalshi ? (trade.outcome === "Yes" ? "BUY" : "SELL") : trade.side;
  const sideClass = isBuy
    ? "bg-pulse-yes/15 text-pulse-yes"
    : "bg-pulse-no/15 text-pulse-no";

  const cardClassName =
    "pulse-card block rounded-2xl p-4 transition-colors hover:border-pulse-accent/40 hover:bg-pulse-surface/30";

  const cardBody = (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${categoryBadgeClass(category.tone)}`}
          >
            {category.label}
          </span>
          <span className="rounded bg-blue-900/50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-300">
            {platform}
          </span>
        </div>
        <span className="shrink-0 text-[11px] font-medium text-pulse-label">
          {recency}
        </span>
      </div>

      <h3 className="text-sm font-bold uppercase leading-snug tracking-wide text-white">
        {trade.title}
      </h3>

      <div className="mt-3 flex items-center gap-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
            whale.anonymous
              ? "bg-pulse-surface text-pulse-label"
              : "bg-pulse-accent/20 text-pulse-accent"
          }`}
        >
          {whale.anonymous ? <AnonymousTraderIcon /> : whale.initials}
        </div>
        <p
          className={`min-w-0 flex-1 truncate text-sm font-semibold ${
            whale.anonymous ? "text-pulse-muted" : "text-white"
          }`}
        >
          {whale.pseudonym}
        </p>
        {winRateLabel !== "—" ? (
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-pulse-yes">
            {winRateLabel} Win Rate
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span
            className={`inline-block max-w-full truncate rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${directionClass}`}
          >
            {positionLabel}
          </span>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${sideClass}`}
        >
          <span aria-hidden>{isBuy ? "↗" : "↘"}</span>
          {sideLabel}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <StatCell label="Entry" value={formatPriceCents(entryPrice)} />
        <StatCell
          label="Now"
          value={formatPriceCents(nowPrice)}
          valueClass={nowPriceClass}
        />
        <StatCell
          label="Stake"
          value={formatStakeCompact(trade.usdNotional)}
        />
        <StatCell
          label={tradeEvStatLabel}
          value={tradeEvLabel}
          sublabel={
            tradeEvDisplay.sublabel ??
            (tradeEvStatLabel === "TRADE EV" ? "VS. MARKET AT ENTRY" : undefined)
          }
          valueClass={tradeEvClass}
        />
      </div>
    </>
  );

  if (!detailHref) {
    return <article className={cardClassName}>{cardBody}</article>;
  }

  return (
    <Link
      href={detailHref}
      onClick={onNavigate}
      className={`${cardClassName} cursor-pointer`}
    >
      {cardBody}
    </Link>
  );
}
