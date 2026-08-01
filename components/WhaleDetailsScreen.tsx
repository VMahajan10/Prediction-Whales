"use client";

import Link from "next/link";
import { useState } from "react";
import MobileAppShell from "@/components/MobileAppShell";
import {
  WHALE_DETAILS_DISCLAIMER,
  WHALE_METRIC_TOOLTIPS,
  type EdgeIndicator,
  type WhaleMetricKey,
  buildWhaleSummaryParagraph,
  formatPriceCents,
  formatStakeCompact,
} from "@/lib/whaleDetails";
import {
  categoryBadgeClass,
  inferCategoryBadge,
} from "@/lib/marketCategory";
import { formatWhaleSignedPercent, formatWhaleWinRatePercent } from "@/lib/whaleIdentityResolver";

export interface WhaleDetailsScreenProps {
  title: string;
  source: "polymarket" | "kalshi";
  side: "BUY" | "SELL";
  backingLabel: string;
  entryPrice: number;
  currentPrice: number;
  stakeUsd: number;
  ageSec?: number;
  whale: {
    pseudonym: string;
    initials: string;
    profileHref?: string | null;
    winRate: number | null;
    wins: number | null;
    losses: number | null;
    totalBets: number | null;
    avgEv: number | null;
    roi?: number | null;
    clvScore?: number;
  };
  edge: EdgeIndicator;
  copyPlayHref: string;
  onCopyPlay?: () => void;
  backHref?: string;
}

function WhaleStatCell({
  label,
  value,
  sublabel,
  tooltipKey,
  valueClassName = "text-white",
}: {
  label: string;
  value: string;
  sublabel?: string;
  tooltipKey: WhaleMetricKey;
  valueClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const tooltip = WHALE_METRIC_TOOLTIPS[tooltipKey];

  return (
    <div className="relative rounded-xl border border-pulse-border bg-pulse-surface/80 px-3 py-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-label">
          {label}
        </p>
        <button
          type="button"
          aria-label={`${label}: ${tooltip}`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-pulse-accent/20 text-[10px] font-bold text-pulse-accent"
        >
          i
        </button>
      </div>
      <p className={`text-lg font-bold leading-tight ${valueClassName}`}>
        {value}
      </p>
      {sublabel ? (
        <p className="mt-1 text-[9px] font-semibold uppercase tracking-wide text-pulse-label">
          {sublabel}
        </p>
      ) : null}
      {open ? (
        <p className="mt-2 text-[11px] leading-relaxed text-pulse-muted">
          {tooltip}
        </p>
      ) : null}
    </div>
  );
}

export default function WhaleDetailsScreen({
  title,
  source,
  side,
  backingLabel,
  entryPrice,
  currentPrice,
  stakeUsd,
  ageSec,
  whale,
  edge,
  copyPlayHref,
  onCopyPlay,
  backHref = "/",
}: WhaleDetailsScreenProps) {
  const category = inferCategoryBadge(title);
  const platformLabel = source === "kalshi" ? "Kalshi" : "Polymarket";
  const isBuy = side === "BUY";
  const summary = buildWhaleSummaryParagraph({
    winRate: whale.winRate,
    avgEv: whale.avgEv,
    totalBets: whale.totalBets,
    entryPrice,
    currentPrice,
    stakeUsd,
  });

  const winRateLabel = formatWhaleWinRatePercent(whale.winRate);
  const winRateClass =
    whale.winRate != null && whale.winRate >= 55
      ? "text-pulse-yes"
      : whale.winRate != null && whale.winRate < 45
        ? "text-pulse-no"
        : "text-white";

  const avgEvLabel = formatWhaleSignedPercent(whale.avgEv);
  const avgEvClass =
    whale.avgEv != null && whale.avgEv >= 0
      ? "text-pulse-yes"
      : whale.avgEv != null
        ? "text-pulse-no"
        : "text-white";

  const wlRecord =
    whale.wins != null && whale.losses != null
      ? `${whale.wins.toLocaleString("en-US")} W · ${whale.losses.toLocaleString("en-US")} L`
      : undefined;

  const edgeClass =
    edge.positive === true
      ? "text-pulse-yes"
      : edge.positive === false
        ? "text-pulse-no"
        : "text-pulse-muted";

  const whaleStrip = (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-pulse-accent/20 text-sm font-bold text-pulse-accent">
        {whale.initials}
      </div>
      <p className="min-w-0 flex-1 truncate text-base font-semibold text-white">
        {whale.pseudonym}
      </p>
      <span className="text-pulse-accent" aria-hidden>
        ›
      </span>
    </div>
  );

  return (
    <MobileAppShell showNav={false}>
      <main className="min-h-screen px-4 pb-8 pt-4">
        <div className="mb-5 flex items-center gap-3">
          <Link
            href={backHref}
            className="text-pulse-muted transition-colors hover:text-white"
            aria-label="Back to feed"
          >
            ←
          </Link>
          <h1 className="flex-1 text-center text-base font-bold text-white">
            Whale Details
          </h1>
          <span className="w-5" aria-hidden />
        </div>

        {whale.profileHref ? (
          <Link
            href={whale.profileHref}
            className="mb-4 block rounded-xl border border-pulse-border bg-pulse-card px-4 py-3 transition-colors hover:border-pulse-accent/40"
          >
            {whaleStrip}
          </Link>
        ) : (
          <div className="mb-4 rounded-xl border border-pulse-border bg-pulse-card px-4 py-3">
            {whaleStrip}
          </div>
        )}

        <article className="rounded-2xl border border-pulse-border bg-pulse-card p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${categoryBadgeClass(category.tone)}`}
              >
                {category.label}
              </span>
              <span className="rounded bg-blue-900/50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-300">
                {platformLabel}
              </span>
            </div>
            {ageSec != null ? (
              <span className="text-[11px] font-medium text-pulse-label">
                {ageSec}s
              </span>
            ) : null}
          </div>

          <h2 className="text-sm font-bold uppercase leading-snug tracking-wide text-white">
            {title}
          </h2>

          <div className="mt-3 flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-pulse-yes">
              {backingLabel}
            </p>
            <span
              className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                isBuy
                  ? "bg-pulse-yes/15 text-pulse-yes"
                  : "bg-pulse-no/15 text-pulse-no"
              }`}
            >
              {side}
            </span>
          </div>

          <p className="mt-4 text-sm leading-relaxed text-pulse-muted">
            {summary}
          </p>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <WhaleStatCell
              label="Win Rate"
              value={winRateLabel}
              sublabel={wlRecord}
              tooltipKey="winRate"
              valueClassName={winRateClass}
            />
            <WhaleStatCell
              label="Total Bets"
              value={
                whale.totalBets != null
                  ? whale.totalBets.toLocaleString("en-US")
                  : "—"
              }
              tooltipKey="totalBets"
            />
            <WhaleStatCell
              label="Stake"
              value={formatStakeCompact(stakeUsd)}
              tooltipKey="stake"
            />
            <WhaleStatCell
              label="Avg. EV"
              value={avgEvLabel}
              sublabel="VS. MARKET AT ENTRY"
              tooltipKey="avgEv"
              valueClassName={avgEvClass}
            />
            <WhaleStatCell
              label="Entry"
              value={formatPriceCents(entryPrice)}
              tooltipKey="entry"
            />
            <WhaleStatCell
              label="Now"
              value={formatPriceCents(currentPrice)}
              tooltipKey="now"
            />
          </div>

          <div
            className={`mt-4 flex items-center justify-between gap-3 text-sm font-bold ${edgeClass}`}
          >
            <span className="flex items-center gap-1">
              <span aria-hidden>
                {edge.positive === true
                  ? "↑"
                  : edge.positive === false
                    ? "↓"
                    : "—"}
              </span>
              {edge.percentLabel}
            </span>
            <span className="text-[11px] uppercase tracking-wide">
              {edge.statusLabel}
            </span>
          </div>

          <div className="mt-4 flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-3">
            <span className="text-amber-400" aria-hidden>
              !
            </span>
            <p className="text-xs leading-relaxed text-amber-100/90">
              {WHALE_DETAILS_DISCLAIMER}
            </p>
          </div>
        </article>

        <a
          href={copyPlayHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onCopyPlay}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-pulse-accent px-6 py-4 text-base font-bold text-black transition-colors hover:bg-pulse-accent/90"
        >
          <span aria-hidden>⧉</span>
          Copy Play
        </a>
      </main>
    </MobileAppShell>
  );
}
