"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  candlestickYesClose,
  type KalshiCandlestick,
} from "@/lib/kalshiDetail";

interface KalshiCandlestickChartProps {
  candlesticks: KalshiCandlestick[];
  tradePrice?: number;
  tradeTimestamp?: number;
  currentPrice?: number | null;
}

const HEIGHT = 300;
const VOL_HEIGHT = 60;
const VOL_GAP = 10;
const XAXIS_HEIGHT = 40;
const SVG_HEIGHT = HEIGHT + VOL_GAP + VOL_HEIGHT + XAXIS_HEIGHT;
const PAD = { top: 20, right: 20, bottom: 40, left: 56 };

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function buildYTicks(minP: number, maxP: number, count = 5): number[] {
  const range = maxP - minP;
  if (range <= 0.001) {
    const mid = (minP + maxP) / 2;
    return [mid - 0.02, mid, mid + 0.02].filter((p) => p >= 0 && p <= 1);
  }
  return Array.from({ length: count }, (_, i) => minP + (range * i) / (count - 1));
}

export default function KalshiCandlestickChart({
  candlesticks,
  tradePrice,
  tradeTimestamp,
  currentPrice,
}: KalshiCandlestickChartProps) {
  const gradId = useId().replace(/:/g, "");
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 800
  );

  const chartW = width - PAD.left - PAD.right;
  const priceH = HEIGHT - PAD.top - PAD.bottom;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth || 800);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const points = useMemo(() => {
    return candlesticks
      .map((c) => {
        const close = candlestickYesClose(c);
        if (close == null) return null;
        return { ...c, close };
      })
      .filter((c): c is KalshiCandlestick & { close: number } => c != null);
  }, [candlesticks]);

  const xLabelIndices = useMemo(() => {
    if (points.length === 0) return [];
    const indices: number[] = [0, points.length - 1];
    const seen = new Set<string>();
    points.forEach((c, i) => {
      const label = formatTime(c.endPeriodTs);
      if (!seen.has(label)) {
        seen.add(label);
        indices.push(i);
      }
    });
    return indices.filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  }, [points]);

  if (points.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-slate-500">
        No candlestick history available for this market yet.
      </div>
    );
  }

  const allPrices = points.map((c) => c.close);
  if (tradePrice != null) allPrices.push(tradePrice);
  if (currentPrice != null && currentPrice > 0) allPrices.push(currentPrice);

  const dataMin = Math.min(...allPrices);
  const dataMax = Math.max(...allPrices);
  const padding = Math.max(0.02, (dataMax - dataMin) * 0.15);
  const minP = Math.max(0, dataMin - padding);
  const maxP = Math.min(1, dataMax + padding);
  const maxVol = Math.max(...points.map((c) => c.volume), 1);

  // Include tradeTimestamp in the domain so a trade more recent than the
  // last candle (or older than the first) still lands inside chartW instead
  // of projecting off the right/left edge of the plot.
  const timestamps = points.map((c) => c.endPeriodTs);
  if (tradeTimestamp != null) timestamps.push(tradeTimestamp);
  const minT = Math.min(...timestamps);
  const maxT = Math.max(...timestamps);
  const timeSpan = Math.max(maxT - minT, 3600);

  const priceToY = (p: number) =>
    PAD.top + (1 - (p - minP) / (maxP - minP || 1)) * priceH;
  const timeToX = (t: number) =>
    PAD.left + ((t - minT) / timeSpan) * chartW;

  const lineCoords = points.map((c) => ({
    t: c.endPeriodTs,
    p: c.close,
    x: timeToX(c.endPeriodTs),
    y: priceToY(c.close),
  }));

  const linePath = lineCoords.map((c) => `${c.x},${c.y}`).join(" ");
  const firstX = lineCoords[0]?.x ?? PAD.left;
  const lastX = lineCoords[lineCoords.length - 1]?.x ?? PAD.left + chartW;
  const anchorY = PAD.top + priceH;

  // Clamp defensively: even with tradeTimestamp folded into the time domain
  // above, this guarantees the marker never renders outside the plot area.
  const tradeX =
    tradeTimestamp != null
      ? Math.min(Math.max(timeToX(tradeTimestamp), PAD.left), PAD.left + chartW)
      : null;
  const tradeY =
    tradePrice != null ? priceToY(tradePrice) : null;

  const yLabels = buildYTicks(minP, maxP);

  const youngMarket = points.length <= 3;

  return (
    <div ref={containerRef} className="relative w-full pb-8">
      {youngMarket && (
        <p className="mb-3 text-xs text-slate-500">
          Young market — limited candlestick history ({points.length} period
          {points.length === 1 ? "" : "s"})
        </p>
      )}
      <div className="touch-pan-y">
        <svg
          width={width}
          height={SVG_HEIGHT}
          className="overflow-visible"
        >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#14b8a6" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#14b8a6" stopOpacity="0" />
          </linearGradient>
        </defs>

        {yLabels.map((p) => {
          const y = priceToY(p);
          return (
            <g key={p}>
              <line
                x1={PAD.left}
                y1={y}
                x2={PAD.left + chartW}
                y2={y}
                stroke="#334155"
                strokeDasharray="4 4"
              />
              <text
                x={PAD.left - 8}
                y={y + 4}
                textAnchor="end"
                className="fill-slate-500 text-[10px]"
              >
                {(p * 100).toFixed(1)}%
              </text>
            </g>
          );
        })}

        <polygon
          points={`${firstX},${anchorY} ${linePath} ${lastX},${anchorY}`}
          fill={`url(#${gradId})`}
        />
        <polyline
          points={linePath}
          fill="none"
          stroke="#14b8a6"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {tradeX != null && tradeY != null && (
          <>
            <line
              x1={tradeX}
              y1={PAD.top}
              x2={tradeX}
              y2={PAD.top + priceH}
              stroke="#fbbf24"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
            <circle cx={tradeX} cy={tradeY} r={5} fill="#fbbf24" />
            <text
              x={Math.min(tradeX + 8, PAD.left + chartW - 60)}
              y={tradeY - 8}
              className="fill-amber-300 text-[10px]"
            >
              This trade
            </text>
          </>
        )}

        {points.map((c) => {
          // Cap bar width so sparse/young markets (few candles) don't produce
          // an oversized bar that reads as a stray gray box in the chart.
          const barW = Math.min(24, Math.max(2, chartW / points.length - 2));
          const x = Math.min(
            Math.max(timeToX(c.endPeriodTs) - barW / 2, PAD.left),
            PAD.left + chartW - barW
          );
          const volH = (c.volume / maxVol) * VOL_HEIGHT;
          if (volH <= 0) return null;
          return (
            <rect
              key={c.endPeriodTs}
              x={x}
              y={HEIGHT + VOL_GAP + VOL_HEIGHT - volH}
              width={barW}
              height={volH}
              fill="#475569"
              opacity={0.7}
            />
          );
        })}

        {xLabelIndices.map((i) => {
          const c = points[i];
          if (!c) return null;
          return (
            <text
              key={`${c.endPeriodTs}-${i}`}
              x={timeToX(c.endPeriodTs)}
              y={HEIGHT + VOL_GAP + VOL_HEIGHT + 14}
              textAnchor="middle"
              className="fill-slate-500 text-[10px]"
            >
              {formatTime(c.endPeriodTs)}
            </text>
          );
        })}
        </svg>
      </div>

      <p className="mt-6 text-xs text-slate-500">
        Hourly Yes-probability candlesticks from Kalshi · volume bars below
      </p>
    </div>
  );
}
