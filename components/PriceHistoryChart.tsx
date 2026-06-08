"use client";

import { useEffect, useRef, useState } from "react";

interface HistoryPoint {
  t: number;
  p: number;
}

interface PriceHistoryChartProps {
  tokenId: string;
}

const HEIGHT = 200;
const PAD = { top: 20, right: 16, bottom: 32, left: 48 };

function getStrokeColor(history: HistoryPoint[]): string {
  if (history.length < 2) return "#3b82f6";
  const firstP = history[0].p;
  const lastP = history[history.length - 1].p;
  if (lastP > firstP) return "#22c55e";
  if (lastP < firstP) return "#ef4444";
  return "#3b82f6";
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

export default function PriceHistoryChart({ tokenId }: PriceHistoryChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(
          `/api/history?tokenId=${encodeURIComponent(tokenId)}`
        );
        const data: { history?: HistoryPoint[] } = await res.json();
        if (!cancelled) {
          setHistory(data.history ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load history");
          setHistory([]);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [tokenId]);

  const chartW = width - PAD.left - PAD.right;
  const chartH = HEIGHT - PAD.top - PAD.bottom;

  if (history === null) {
    return (
      <div ref={containerRef} className="w-full">
        <p className="py-12 text-center text-sm text-pulse-muted animate-pulse">
          Loading chart…
        </p>
      </div>
    );
  }

  if (error || history.length < 2) {
    return (
      <div ref={containerRef} className="w-full">
        <p className="py-12 text-center text-sm text-pulse-muted">
          {error ?? "Insufficient price history"}
        </p>
      </div>
    );
  }

  const minT = history[0].t;
  const maxT = history[history.length - 1].t;
  const minP = Math.min(...history.map((h) => h.p));
  const maxP = Math.max(...history.map((h) => h.p));
  const isFlat = maxP - minP < 0.01;
  const range = isFlat ? 0.01 : maxP - minP;
  const midY = PAD.top + chartH / 2;

  const coords = history.map((h) => {
    const x = PAD.left + ((h.t - minT) / (maxT - minT || 1)) * chartW;
    const y = isFlat
      ? midY
      : PAD.top + chartH - ((h.p - minP) / range) * chartH;
    return { x, y };
  });

  const pointsString = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const stroke = getStrokeColor(history);
  const gradId = `chart-grad-${tokenId.slice(-8)}`;
  const firstX = coords[0].x;
  const lastX = coords[coords.length - 1].x;
  const anchorY = isFlat ? midY : PAD.top + chartH;

  const yLabels = [0, 0.25, 0.5, 0.75, 1];
  const timeLabels = [
    history[0],
    history[Math.floor(history.length / 2)],
    history[history.length - 1],
  ];

  return (
    <div ref={containerRef} className="w-full">
      <svg width={width} height={HEIGHT} className="overflow-visible">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        {yLabels.map((prob) => {
          const y = PAD.top + chartH - prob * chartH;
          return (
            <g key={prob}>
              <line
                x1={PAD.left}
                y1={y}
                x2={PAD.left + chartW}
                y2={y}
                stroke="#334155"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 8}
                y={y + 4}
                textAnchor="end"
                className="fill-slate-500 text-[10px]"
              >
                {prob * 100}%
              </text>
            </g>
          );
        })}

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

        {timeLabels.map((point, i) => {
          const x =
            PAD.left +
            ((point.t - minT) / (maxT - minT || 1)) * chartW;
          return (
            <text
              key={`${point.t}-${i}`}
              x={x}
              y={HEIGHT - 8}
              textAnchor="middle"
              className="fill-slate-500 text-[10px]"
            >
              {formatTime(point.t)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
