import type { ArbitrageWindow } from "@/lib/arbitrageFinder/types";

export function sortArbitrageWindowsByRoi(
  windows: ArbitrageWindow[]
): ArbitrageWindow[] {
  return [...windows].sort((a, b) => b.roiPercent - a.roiPercent);
}

export function filterActionableWindows(
  windows: ArbitrageWindow[]
): ArbitrageWindow[] {
  return windows.filter((w) => w.isActionable);
}

export function topArbitrageWindows(
  windows: ArbitrageWindow[],
  top = 8
): ArbitrageWindow[] {
  return sortArbitrageWindowsByRoi(filterActionableWindows(windows)).slice(
    0,
    Math.max(0, top)
  );
}

export function formatArbLockLabel(window: ArbitrageWindow): string {
  return `+${window.roiPercent.toFixed(1)}% lock`;
}

export function formatArbPairLabel(window: ArbitrageWindow): string {
  return `${window.polymarketTokenId.slice(0, 8)}… · ${window.kalshiTicker}`;
}
