"use client";

import { useEffect, useState } from "react";

interface HistoryPoint {
  t: number;
  p: number;
}

interface SparklineProps {
  tokenId?: string;
  width?: number;
  height?: number;
}

function renderFlatBlueLine(width: number, height: number) {
  const pointsString = flatLinePoints(width, height);
  const stroke = "#3b82f6";

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline
        points={pointsString}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const FLAT_GRAY = "#6b7280";

function getStrokeColor(history: HistoryPoint[]): string {
  if (history.length < 2) return "#3b82f6";
  const firstP = history[0].p;
  const lastP = history[history.length - 1].p;
  if (lastP > firstP) return "#22c55e";
  if (lastP < firstP) return "#ef4444";
  return "#3b82f6";
}

function flatLinePoints(width: number, height: number): string {
  const y = height / 2;
  return `0,${y} ${width},${y}`;
}

function buildSparklineGeometry(
  history: HistoryPoint[],
  width: number,
  height: number
): {
  pointsString: string;
  firstX: number;
  lastX: number;
  anchorY: number;
} {
  const minT = history[0].t;
  const maxT = history[history.length - 1].t;
  const minP = Math.min(...history.map((h) => h.p));
  const maxP = Math.max(...history.map((h) => h.p));
  const isFlat = maxP - minP < 0.01;
  const range = isFlat ? 0.01 : maxP - minP;
  const midY = height / 2;

  const coords = history.map((h) => {
    const x = ((h.t - minT) / (maxT - minT || 1)) * width;
    const y = isFlat
      ? midY
      : height - ((h.p - minP) / range) * height;
    return { x, y };
  });

  const pointsString = coords.map((c) => `${c.x},${c.y}`).join(" ");

  return {
    pointsString,
    firstX: coords[0].x,
    lastX: coords[coords.length - 1].x,
    anchorY: isFlat ? midY : height,
  };
}

export default function Sparkline({
  tokenId = "",
  width = 120,
  height = 32,
}: SparklineProps) {
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  const gradId = `grad-${tokenId ? tokenId.slice(-8) : "empty"}`;

  useEffect(() => {
    if (!tokenId) return;

    let cancelled = false;

    async function loadHistory() {
      try {
        const res = await fetch(
          `/api/history?tokenId=${encodeURIComponent(tokenId)}`
        );
        const data: { history?: HistoryPoint[] } = await res.json();
        if (!cancelled) {
          setHistory(data.history ?? []);
        }
      } catch {
        if (!cancelled) {
          setHistory([]);
        }
      }
    }

    loadHistory();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!tokenId) {
    return renderFlatBlueLine(width, height);
  }

  if (history === null) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <polyline
          points={flatLinePoints(width, height)}
          fill="none"
          stroke={FLAT_GRAY}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (history.length < 2) {
    return renderFlatBlueLine(width, height);
  }

  const stroke = getStrokeColor(history);
  const { pointsString, firstX, lastX, anchorY } = buildSparklineGeometry(
    history,
    width,
    height
  );

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.3" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={`${firstX},${anchorY} ${pointsString} ${lastX},${anchorY}`}
        fill={`url(#${gradId})`}
      />
      <polyline
        points={pointsString}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
