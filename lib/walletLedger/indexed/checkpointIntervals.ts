export interface BlockRange {
  from: number;
  to: number;
}

export function rangeLength(range: BlockRange): number {
  if (range.to < range.from) return 0;
  return range.to - range.from + 1;
}

export function rangesTotalBlocks(ranges: BlockRange[]): number {
  return ranges.reduce((sum, range) => sum + rangeLength(range), 0);
}

export function normalizeRanges(ranges: BlockRange[]): BlockRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges]
    .filter((range) => range.to >= range.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: BlockRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ ...range });
      continue;
    }
    if (range.from <= last.to + 1) {
      last.to = Math.max(last.to, range.to);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

export function intersectRange(
  left: BlockRange,
  right: BlockRange
): BlockRange | null {
  const from = Math.max(left.from, right.from);
  const to = Math.min(left.to, right.to);
  if (to < from) return null;
  return { from, to };
}

export function intersectRanges(
  ranges: BlockRange[],
  window: BlockRange
): BlockRange[] {
  const hits: BlockRange[] = [];
  for (const range of normalizeRanges(ranges)) {
    const hit = intersectRange(range, window);
    if (hit) hits.push(hit);
  }
  return normalizeRanges(hits);
}

export function subtractRange(window: BlockRange, covered: BlockRange): BlockRange[] {
  const hit = intersectRange(window, covered);
  if (!hit) return [{ ...window }];
  const gaps: BlockRange[] = [];
  if (hit.from > window.from) {
    gaps.push({ from: window.from, to: hit.from - 1 });
  }
  if (hit.to < window.to) {
    gaps.push({ from: hit.to + 1, to: window.to });
  }
  return gaps;
}

export function subtractRanges(
  window: BlockRange,
  covered: BlockRange[]
): BlockRange[] {
  let gaps: BlockRange[] = [{ ...window }];
  for (const range of normalizeRanges(covered)) {
    gaps = gaps.flatMap((gap) => subtractRange(gap, range));
    if (gaps.length === 0) break;
  }
  return normalizeRanges(gaps);
}

export function highestCompletedBlock(ranges: BlockRange[]): number | null {
  const normalized = normalizeRanges(ranges);
  if (normalized.length === 0) return null;
  return normalized[normalized.length - 1]!.to;
}

export interface CheckpointResumePlan {
  requested: BlockRange;
  covered: BlockRange[];
  reusedRanges: BlockRange[];
  uncoveredRanges: BlockRange[];
  requestedBlocks: number;
  reusedBlocks: number;
  newBlocksToFetch: number;
}

export function computeCheckpointResumePlan(
  requestedFrom: number,
  requestedTo: number,
  completedRanges: BlockRange[]
): CheckpointResumePlan {
  const requested: BlockRange = { from: requestedFrom, to: requestedTo };
  const covered = intersectRanges(completedRanges, requested);
  const uncoveredRanges = subtractRanges(requested, covered);
  const reusedBlocks = rangesTotalBlocks(covered);
  const requestedBlocks = rangeLength(requested);
  const newBlocksToFetch = rangesTotalBlocks(uncoveredRanges);

  return {
    requested,
    covered,
    reusedRanges: covered,
    uncoveredRanges,
    requestedBlocks,
    reusedBlocks,
    newBlocksToFetch,
  };
}

export function formatBlockRanges(ranges: BlockRange[]): string {
  if (ranges.length === 0) return "none";
  return ranges.map((range) => `${range.from}-${range.to}`).join(",");
}
