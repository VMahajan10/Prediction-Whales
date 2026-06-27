"use client";

import { useMemo, useState } from "react";
import type { TraderClosedPosition, TraderOpenPosition } from "@/lib/traderProfile";
import {
  formatResolvedDate,
  formatTraderPnl,
  formatTraderPrice,
  polymarketPositionUrl,
  TRADER_HISTORY_PAGE_SIZE,
} from "@/lib/traderProfile";
import type { useWhaleTrackRecord } from "@/lib/useWhaleTrackRecord";

interface TraderProfileHistoryProps {
  record: ReturnType<typeof useWhaleTrackRecord>;
}

function ResultBadge({ result }: { result: TraderClosedPosition["result"] }) {
  if (result === "won") {
    return (
      <span className="rounded-full bg-pulse-yes/20 px-2 py-0.5 text-xs font-semibold text-pulse-yes">
        Won
      </span>
    );
  }
  if (result === "lost") {
    return (
      <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-semibold text-red-400">
        Lost
      </span>
    );
  }
  return (
    <span className="rounded-full bg-slate-600/40 px-2 py-0.5 text-xs font-semibold text-slate-300">
      Breakeven
    </span>
  );
}

function ClosedRow({ position }: { position: TraderClosedPosition }) {
  const pnlClass =
    position.realizedPnl >= 0 ? "text-pulse-yes" : "text-red-400";

  return (
    <tr className="border-b border-slate-700/60 last:border-0">
      <td className="px-3 py-3 align-top">
        <a
          href={polymarketPositionUrl(position)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-white hover:text-pulse-accent hover:underline"
        >
          {position.title}
        </a>
        {position.excludedFromStats && (
          <p className="mt-1 text-[10px] text-slate-500">
            Excluded from headline stats (short-term market)
          </p>
        )}
      </td>
      <td className="hidden px-3 py-3 align-top text-sm text-slate-300 sm:table-cell">
        {position.outcome}
      </td>
      <td className="px-3 py-3 align-top text-sm text-slate-300">
        {formatTraderPrice(position.avgPrice)}
      </td>
      <td className="hidden px-3 py-3 align-top text-sm text-white md:table-cell">
        ${Math.round(position.sizeUsd).toLocaleString("en-US")}
      </td>
      <td className="px-3 py-3 align-top">
        <ResultBadge result={position.result} />
      </td>
      <td className={`px-3 py-3 align-top text-sm font-semibold ${pnlClass}`}>
        {formatTraderPnl(position.realizedPnl)}
      </td>
      <td className="hidden px-3 py-3 align-top text-sm text-slate-400 lg:table-cell">
        {formatResolvedDate(position.resolvedAt)}
      </td>
    </tr>
  );
}

function OpenRow({ position }: { position: TraderOpenPosition }) {
  const pnlClass =
    position.unrealizedPnl >= 0 ? "text-pulse-yes" : "text-red-400";

  return (
    <tr className="border-b border-slate-700/60 last:border-0">
      <td className="px-3 py-3 align-top">
        <a
          href={polymarketPositionUrl(position)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-white hover:text-pulse-accent hover:underline"
        >
          {position.title}
        </a>
      </td>
      <td className="hidden px-3 py-3 align-top text-sm text-slate-300 sm:table-cell">
        {position.outcome}
      </td>
      <td className="px-3 py-3 align-top text-sm text-slate-300">
        {formatTraderPrice(position.avgPrice)}
      </td>
      <td className="hidden px-3 py-3 align-top text-sm text-white md:table-cell">
        ${Math.round(position.sizeUsd).toLocaleString("en-US")}
      </td>
      <td className="px-3 py-3 align-top text-sm text-slate-300">
        {formatTraderPrice(position.currentPrice)}
      </td>
      <td className={`px-3 py-3 align-top text-sm font-semibold ${pnlClass}`}>
        {formatTraderPnl(position.unrealizedPnl)}
        {position.percentPnl != null && (
          <span className="ml-1 text-xs font-normal text-slate-500">
            ({position.percentPnl >= 0 ? "+" : ""}
            {position.percentPnl.toFixed(1)}%)
          </span>
        )}
      </td>
    </tr>
  );
}

export default function TraderProfileHistory({
  record,
}: TraderProfileHistoryProps) {
  const [visibleClosed, setVisibleClosed] = useState(TRADER_HISTORY_PAGE_SIZE);
  const {
    closedPositions,
    openPositions,
    closedPositionsFetched,
    closedPositionsApiLimit,
    loading,
    error,
  } = record;

  const displayClosed = useMemo(
    () => closedPositions.filter((p) => !p.excludedFromStats),
    [closedPositions]
  );
  const allClosedForList = useMemo(
    () => closedPositions,
    [closedPositions]
  );
  const visibleRows = allClosedForList.slice(0, visibleClosed);
  const canLoadMore = visibleClosed < allClosedForList.length;

  if (loading && closedPositions.length === 0 && openPositions.length === 0) {
    return (
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-2 text-lg font-semibold text-white">
          📋 Trade History
        </h2>
        <p className="text-sm text-slate-400 animate-pulse">
          Loading position history…
        </p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-2 text-lg font-semibold text-white">
          📋 Trade History
        </h2>
        <p className="text-sm text-red-400">{error}</p>
      </section>
    );
  }

  const fetchedLabel =
    closedPositionsFetched >= closedPositionsApiLimit
      ? `Showing up to ${closedPositionsApiLimit} most recent closed positions from Polymarket (API limit — not necessarily their full lifetime history).`
      : closedPositionsFetched > 0
        ? `Showing ${closedPositionsFetched} closed position${closedPositionsFetched === 1 ? "" : "s"} returned by Polymarket (may not include their entire trading history).`
        : "No closed position history returned by Polymarket for this wallet.";

  return (
    <>
      {openPositions.length > 0 && (
        <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
          <h2 className="mb-1 text-lg font-semibold text-white">
            📂 Open Positions
          </h2>
          <p className="mb-4 text-xs text-slate-500">
            Current active bets — {openPositions.length} open position
            {openPositions.length === 1 ? "" : "s"}
          </p>
          <div className="overflow-x-auto rounded-lg border border-slate-700">
            <table className="min-w-full text-left">
              <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Market</th>
                  <th className="hidden px-3 py-2 font-medium sm:table-cell">
                    Side
                  </th>
                  <th className="px-3 py-2 font-medium">Entry</th>
                  <th className="hidden px-3 py-2 font-medium md:table-cell">
                    Size
                  </th>
                  <th className="px-3 py-2 font-medium">Now</th>
                  <th className="px-3 py-2 font-medium">Unrealized P&L</th>
                </tr>
              </thead>
              <tbody>
                {openPositions.map((position) => (
                  <OpenRow key={position.id} position={position} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-1 text-lg font-semibold text-white">
          ✅ Closed Positions
        </h2>
        <p className="mb-4 text-xs leading-relaxed text-slate-500">
          {fetchedLabel}{" "}
          {displayClosed.length !== allClosedForList.length && (
            <>
              Headline win rate excludes{" "}
              {allClosedForList.length - displayClosed.length} short-term
              bot-style market
              {allClosedForList.length - displayClosed.length === 1 ? "" : "s"}.
            </>
          )}
        </p>

        {allClosedForList.length === 0 ? (
          <p className="text-sm text-slate-400">
            No settled positions to show yet.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-slate-700">
              <table className="min-w-full text-left">
                <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Market</th>
                    <th className="hidden px-3 py-2 font-medium sm:table-cell">
                      Side
                    </th>
                    <th className="px-3 py-2 font-medium">Entry</th>
                    <th className="hidden px-3 py-2 font-medium md:table-cell">
                      Size
                    </th>
                    <th className="px-3 py-2 font-medium">Outcome</th>
                    <th className="px-3 py-2 font-medium">Realized P&L</th>
                    <th className="hidden px-3 py-2 font-medium lg:table-cell">
                      Resolved
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((position) => (
                    <ClosedRow key={position.id} position={position} />
                  ))}
                </tbody>
              </table>
            </div>
            {canLoadMore && (
              <button
                type="button"
                onClick={() =>
                  setVisibleClosed((n) =>
                    Math.min(n + TRADER_HISTORY_PAGE_SIZE, allClosedForList.length)
                  )
                }
                className="mt-4 rounded-lg border border-pulse-border bg-slate-900/60 px-4 py-2 text-sm text-slate-300 transition-colors hover:border-pulse-accent/50 hover:text-white"
              >
                Load more ({visibleRows.length} of {allClosedForList.length}{" "}
                shown)
              </button>
            )}
          </>
        )}
      </section>
    </>
  );
}
