"use client";

import Link from "next/link";
import {
  categoryBadgeClass,
  inferCategoryBadge,
} from "@/lib/marketCategory";
import { formatFeedRecency } from "@/lib/whaleFeedCategories";
import { formatPriceCents, formatStakeCompact } from "@/lib/whaleDetails";
import {
  formatWhaleSignedPercent,
  formatWhaleWinRatePercent,
  sanitizeWhaleDisplayName,
} from "@/lib/whaleIdentityResolver";
import type { WhaleTrade } from "@/lib/whaleTrades";

export interface WhaleFeedCardProps {
  trade: WhaleTrade;
  now: number;
  detailHref: string | null;
  onNavigate?: () => void;
  currentPrice?: number;
}

function resolveFeedWhaleIdentity(trade: WhaleTrade) {
  const wallet = trade.proxyWallet ?? "unknown";
  const identity = trade.whaleIdentity;
  const pseudonym = sanitizeWhaleDisplayName(
    identity?.pseudonym ?? null,
    wallet
  );

  return {
    pseudonym,
    initials: identity?.initials ?? pseudonym.slice(0, 2).toUpperCase(),
    winRate: identity?.winRate ?? null,
    avgEv: identity?.avgEv ?? trade.averageEv ?? null,
  };
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
  const avgEvLabel = formatWhaleSignedPercent(whale.avgEv);
  const avgEvClass =
    whale.avgEv != null && whale.avgEv >= 0
      ? "text-pulse-yes"
      : whale.avgEv != null
        ? "text-pulse-no"
        : "text-pulse-label";

  const priceMovedAgainst =
    isBuy ? nowPrice < entryPrice - 0.005 : nowPrice > entryPrice + 0.005;
  const nowPriceClass = priceMovedAgainst ? "text-pulse-no" : "text-white";

  const backingLabel =
    trade.marketTranslation?.backingLabel ??
    (isBuy ? `Backing ${trade.outcome}` : "Exiting position");
  const exitLabel = trade.marketTranslation?.exitByLabel;
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
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-pulse-accent/20 text-xs font-bold text-pulse-accent">
          {whale.initials}
        </div>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
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
            {exitLabel ?? backingLabel}
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
          label="Avg. EV"
          value={avgEvLabel}
          sublabel="VS. MARKET AT ENTRY"
          valueClass={avgEvClass}
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
