"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

interface HistoryPoint {
  t: number;
  p: number;
}

interface SelectedPoint {
  t: number;
  p: number;
  x: number;
  y: number;
}

export interface MarketPriceChartProps {
  tokenId: string;
  currentPrice: number;
  marketQuestion: string;
  refreshInterval?: number;
}

const HEIGHT = 280;
const PAD = { top: 20, right: 20, bottom: 40, left: 60 };
const Y_LINES = [0, 0.25, 0.5, 0.75, 1.0];

function getStrokeColor(history: HistoryPoint[]): string {
  if (history.length < 2) return "#3b82f6";
  const firstP = history[0].p;
  const lastP = history[history.length - 1].p;
  if (lastP > firstP) return "#22c55e";
  if (lastP < firstP) return "#ef4444";
  return "#3b82f6";
}

function formatTimeHM(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function formatTimeHMS(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  const s = date.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function mergeHistory(
  prev: HistoryPoint[],
  apiHistory: HistoryPoint[],
  livePrice: number
): HistoryPoint[] {
  const byTime = new Map<number, number>();
  for (const pt of apiHistory) byTime.set(pt.t, pt.p);
  for (const pt of prev) byTime.set(pt.t, pt.p);

  const sorted = Array.from(byTime.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([t, p]) => ({ t, p }));

  const now = Math.floor(Date.now() / 1000);
  const last = sorted[sorted.length - 1];

  if (!last) {
    sorted.push({ t: now, p: livePrice });
  } else if (last.p !== livePrice) {
    if (last.t === now) {
      sorted[sorted.length - 1] = { t: now, p: livePrice };
    } else {
      sorted.push({ t: now, p: livePrice });
    }
  }

  return sorted;
}

function priceToY(p: number, chartH: number): number {
  return PAD.top + (1 - p) * chartH;
}

function timeToX(
  t: number,
  minT: number,
  maxT: number,
  chartW: number
): number {
  return PAD.left + ((t - minT) / (maxT - minT || 1)) * chartW;
}

export default function MarketPriceChart({
  tokenId,
  currentPrice,
  marketQuestion,
  refreshInterval = 10000,
}: MarketPriceChartProps) {
  const gradId = useId().replace(/:/g, "");
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<SelectedPoint | null>(
    null
  );
  const [progress, setProgress] = useState(0);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [mouseX, setMouseX] = useState<number | null>(null);

  const chartW = width - PAD.left - PAD.right;
  const chartH = HEIGHT - PAD.top - PAD.bottom;

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/history?tokenId=${encodeURIComponent(tokenId)}`
      );
      const data: { history?: HistoryPoint[] } = await res.json();
      setHistory((prev) => mergeHistory(prev, data.history ?? [], currentPrice));
      setLastUpdated(new Date());
    } catch {
      setHistory((prev) => mergeHistory(prev, [], currentPrice));
      setLastUpdated(new Date());
    } finally {
      setIsLoading(false);
    }
  }, [tokenId, currentPrice]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => setWidth(el.clientWidth || 800);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setIsLoading(true);
    setHistory([]);
    fetchHistory();
    const interval = setInterval(fetchHistory, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchHistory, refreshInterval]);

  useEffect(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      return mergeHistory(prev, [], currentPrice);
    });
  }, [currentPrice]);

  useEffect(() => {
    const timer = setInterval(() => {
      setProgress((p) => (p >= 100 ? 0 : p + 1));
    }, refreshInterval / 100);
    return () => clearInterval(timer);
  }, [refreshInterval]);

  useEffect(() => {
    if (!lastUpdated) return;
    const tick = () =>
      setSecondsAgo(
        Math.floor((Date.now() - lastUpdated.getTime()) / 1000)
      );
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [lastUpdated]);

  const displayHistory =
    history.length <= 1
      ? [
          {
            t: Math.floor(Date.now() / 1000) - 3600,
            p: currentPrice,
          },
          { t: Math.floor(Date.now() / 1000), p: currentPrice },
        ]
      : history;

  const minT = displayHistory[0].t;
  const maxT = displayHistory[displayHistory.length - 1].t;
  const stroke = getStrokeColor(
    history.length <= 1 ? [{ t: 0, p: currentPrice }, { t: 1, p: currentPrice }] : history
  );

  const coords = displayHistory.map((h) => ({
    ...h,
    x: timeToX(h.t, minT, maxT, chartW),
    y: priceToY(h.p, chartH),
  }));

  const pointsString = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const firstX = coords[0].x;
  const lastX = coords[coords.length - 1].x;
  const lastY = coords[coords.length - 1].y;
  const anchorY = PAD.top + chartH;

  const firstP = history.length > 0 ? history[0].p : currentPrice;
  const lastP =
    history.length > 0 ? history[history.length - 1].p : currentPrice;
  const changePct = (lastP - firstP) * 100;
  const highP = Math.max(...displayHistory.map((h) => h.p));
  const lowP = Math.min(...displayHistory.map((h) => h.p));

  const xLabelCount = 5;
  const xLabels = Array.from({ length: xLabelCount }, (_, i) => {
    const t = minT + ((maxT - minT) / (xLabelCount - 1 || 1)) * i;
    return { t, x: timeToX(t, minT, maxT, chartW) };
  });

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * width;
    setMouseX(x);

    let nearest = coords[0];
    let minDist = Math.abs(x - nearest.x);
    for (const c of coords) {
      const dist = Math.abs(x - c.x);
      if (dist < minDist) {
        minDist = dist;
        nearest = c;
      }
    }
    setSelectedPoint({
      t: nearest.t,
      p: nearest.p,
      x: nearest.x,
      y: nearest.y,
    });
  };

  const handleMouseLeave = () => {
    setMouseX(null);
    setSelectedPoint(null);
  };

  const tooltipOnRight = mouseX != null && mouseX < width / 2;
  const refreshSeconds = refreshInterval / 1000;
  const sparseHistory = history.length <= 1;

  return (
    <div ref={containerRef} className="w-full">
      <p className="mb-1 truncate text-xs text-slate-500" title={marketQuestion}>
        {marketQuestion}
      </p>

      {!isLoading && history.length >= 2 && (
        <p
          className={`mb-3 text-sm font-medium ${
            changePct > 0
              ? "text-green-400"
              : changePct < 0
                ? "text-red-400"
                : "text-blue-400"
          }`}
        >
          {changePct > 0 ? "▲" : changePct < 0 ? "▼" : "—"}{" "}
          {changePct > 0 ? "+" : ""}
          {changePct.toFixed(1)}% in the last hour
        </p>
      )}

      {isLoading ? (
        <p className="py-16 text-center text-sm text-pulse-muted animate-pulse">
          Loading chart…
        </p>
      ) : (
        <>
          <svg
            width={width}
            height={HEIGHT}
            className="overflow-visible"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity="0.2" />
                <stop offset="100%" stopColor={stroke} stopOpacity="0" />
              </linearGradient>
            </defs>

            {Y_LINES.map((p) => {
              const y = priceToY(p, chartH);
              return (
                <g key={p}>
                  <line
                    x1={PAD.left}
                    y1={y}
                    x2={PAD.left + chartW}
                    y2={y}
                    stroke="#334155"
                    strokeWidth="1"
                    strokeDasharray="4 4"
                  />
                  <text
                    x={PAD.left - 8}
                    y={y + 4}
                    textAnchor="end"
                    className="fill-slate-500 text-[10px]"
                  >
                    {p * 100}%
                  </text>
                </g>
              );
            })}

            {xLabels.map((label) => (
              <text
                key={label.t}
                x={label.x}
                y={HEIGHT - 10}
                textAnchor="middle"
                className="fill-slate-500 text-[10px]"
              >
                {formatTimeHM(label.t)}
              </text>
            ))}

            <polygon
              points={`${firstX},${anchorY} ${pointsString} ${lastX},${anchorY}`}
              fill={`url(#${gradId})`}
            />
            <polyline
              points={pointsString}
              fill="none"
              stroke={stroke}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {!sparseHistory && (
              <>
                <circle cx={lastX} cy={lastY} r={5} fill="#22c55e">
                  <animate
                    attributeName="r"
                    values="4;7;4"
                    dur="2s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    values="1;0.5;1"
                    dur="2s"
                    repeatCount="indefinite"
                  />
                </circle>
              </>
            )}

            {selectedPoint && (
              <>
                <line
                  x1={selectedPoint.x}
                  y1={PAD.top}
                  x2={selectedPoint.x}
                  y2={PAD.top + chartH}
                  stroke="#64748b"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                />
                <line
                  x1={PAD.left}
                  y1={selectedPoint.y}
                  x2={PAD.left + chartW}
                  y2={selectedPoint.y}
                  stroke="#64748b"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                />
                <g
                  transform={`translate(${
                    tooltipOnRight
                      ? selectedPoint.x + 12
                      : selectedPoint.x - 132
                  }, ${Math.max(PAD.top, selectedPoint.y - 40)})`}
                >
                  <rect
                    x={0}
                    y={0}
                    width={120}
                    height={44}
                    rx={6}
                    fill="#1e293b"
                    stroke="#475569"
                    strokeWidth="1"
                  />
                  <text x={10} y={18} className="fill-slate-300 text-[11px]">
                    Time: {formatTimeHMS(selectedPoint.t)}
                  </text>
                  <text x={10} y={34} className="fill-white text-[11px]">
                    Probability: {(selectedPoint.p * 100).toFixed(1)}%
                  </text>
                </g>
              </>
            )}
          </svg>

          {sparseHistory && (
            <p className="mt-2 text-center text-xs text-slate-500">
              Not enough history to chart — collecting data in real time…
            </p>
          )}

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
              <p className="text-xs text-slate-500">Current</p>
              <p className="text-lg font-semibold text-white">
                {(lastP * 100).toFixed(1)}%
              </p>
            </div>
            <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
              <p className="text-xs text-slate-500">High</p>
              <p className="text-lg font-semibold text-green-400">
                {(highP * 100).toFixed(1)}%
              </p>
            </div>
            <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
              <p className="text-xs text-slate-500">Low</p>
              <p className="text-lg font-semibold text-red-400">
                {(lowP * 100).toFixed(1)}%
              </p>
            </div>
            <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
              <p className="text-xs text-slate-500">Change</p>
              <p
                className={`text-lg font-semibold ${
                  changePct > 0
                    ? "text-green-400"
                    : changePct < 0
                      ? "text-red-400"
                      : "text-white"
                }`}
              >
                {changePct > 0 ? "+" : ""}
                {changePct.toFixed(1)}%
              </p>
            </div>
          </div>

          <div className="mt-4">
            <p className="mb-2 text-xs text-slate-500">
              Last updated: {secondsAgo}s ago · refreshes every {refreshSeconds}s
            </p>
            <div className="h-1 overflow-hidden rounded-full bg-slate-700">
              <div
                className="h-full rounded-full bg-green-500 transition-all duration-100"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
