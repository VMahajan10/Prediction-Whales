import { inferCategoryBadge, inferMarketCategory, type MarketCategory } from "@/lib/marketCategory";

export const LIMITED_DATA_POSITION_FLOOR = 30;
/** Optional filter presets (directory / watchlist). */
export const DEFAULT_MIN_PROFIT_FACTOR = 1.5;
/** No minimum PF — directory default. */
export const DIRECTORY_DEFAULT_MIN_PROFIT_FACTOR = 0;
export const DEFAULT_MIN_POSITION_COUNT = 30;

export interface ProfitFactorPosition {
  realizedPnl: number;
  title?: string;
  /** Event-tag category from Gamma (preferred over title inference). */
  categoryLabel?: string;
  excludedFromStats?: boolean;
  hasReliableTitle?: boolean;
  hasReliableCategory?: boolean;
}

export type ProfitFactorAvailability = "verified" | "unavailable" | "syncing";

export interface ProfitFactorSlice {
  categoryLabel: string;
  positionCount: number;
  grossProfit: number;
  grossLoss: number;
  /** Null when gross loss is zero (display "No losses yet"). */
  profitFactor: number | null;
  profitFactorExBest: number | null;
  limitedData: boolean;
  winCount: number;
  lossCount: number;
  /** Wins / (wins + losses); pushes (realizedPnl === 0) excluded. */
  winRatePct: number | null;
}

export interface WalletProfitFactorStats {
  availability: ProfitFactorAvailability;
  /** Per-wallet reconciliation passed (sum CLOSED realized vs /v2/user-pnl). */
  verified: boolean;
  overall: ProfitFactorSlice | null;
  excludingBestTrade: ProfitFactorSlice | null;
  byCategoryLabel: ProfitFactorSlice[];
  /** Headline profile PnL from /v2/user-pnl when available. */
  netRealizedPnl: number | null;
  headlineRealizedPnl: number | null;
  reconciliationGapPct: number | null;
  closedWinCount: number | null;
  closedLossCount: number | null;
  winRatePct: number | null;
}

export function formatProfitFactorValue(
  profitFactor: number | null,
  options?: { zeroLossLabel?: string }
): string {
  if (profitFactor == null) {
    return options?.zeroLossLabel ?? "No losses yet";
  }
  if (!Number.isFinite(profitFactor)) return "—";
  return profitFactor.toFixed(2);
}

export function formatProfitFactorUnavailable(): string {
  return "Not enough history";
}

export function formatProfitFactorLine(slice: ProfitFactorSlice): string {
  const pf = formatProfitFactorValue(slice.profitFactor);
  const noun = slice.positionCount === 1 ? "position" : "positions";
  return `PF ${pf} (${slice.categoryLabel}, ${slice.positionCount.toLocaleString()} ${noun})`;
}

export function formatProfitFactorLineOrUnavailable(
  stats: WalletProfitFactorStats | null | undefined,
  slice: ProfitFactorSlice | null | undefined
): string {
  if (!stats || stats.availability !== "verified" || !slice) {
    return `PF ${formatProfitFactorUnavailable()}`;
  }
  return formatProfitFactorLine(slice);
}

export function formatProfitFactorSummary(
  categorySlice: ProfitFactorSlice,
  overall: ProfitFactorSlice
): string {
  return `${formatProfitFactorLine(categorySlice)} · ${formatProfitFactorLine(overall)}`;
}

function grossTotals(positions: ProfitFactorPosition[]): {
  grossProfit: number;
  grossLoss: number;
} {
  let grossProfit = 0;
  let grossLoss = 0;
  for (const p of positions) {
    if (p.realizedPnl > 0) grossProfit += p.realizedPnl;
    else if (p.realizedPnl < 0) grossLoss += Math.abs(p.realizedPnl);
  }
  return { grossProfit, grossLoss };
}

function profitFactorFromTotals(
  grossProfit: number,
  grossLoss: number
): number | null {
  if (grossLoss <= 0) return null;
  return grossProfit / grossLoss;
}

/** Match overall win-rate rules in profitFactorService (exclude pushes). */
export function winLossCountsFromPositions(
  positions: ProfitFactorPosition[]
): { wins: number; losses: number } {
  let wins = 0;
  let losses = 0;
  for (const p of positions) {
    if (p.realizedPnl > 0) wins++;
    else if (p.realizedPnl < 0) losses++;
  }
  return { wins, losses };
}

function winRatePctFromCounts(wins: number, losses: number): number | null {
  const decided = wins + losses;
  if (decided <= 0) return null;
  return (wins / decided) * 100;
}

function buildSlice(
  categoryLabel: string,
  positions: ProfitFactorPosition[]
): ProfitFactorSlice {
  const { grossProfit, grossLoss } = grossTotals(positions);
  const exBest = positionsExcludingBestWin(positions);
  const exBestTotals = grossTotals(exBest);
  const { wins, losses } = winLossCountsFromPositions(positions);
  return {
    categoryLabel,
    positionCount: positions.length,
    grossProfit,
    grossLoss,
    profitFactor: profitFactorFromTotals(grossProfit, grossLoss),
    profitFactorExBest: profitFactorFromTotals(
      exBestTotals.grossProfit,
      exBestTotals.grossLoss
    ),
    limitedData: positions.length < LIMITED_DATA_POSITION_FLOOR,
    winCount: wins,
    lossCount: losses,
    winRatePct: winRatePctFromCounts(wins, losses),
  };
}

function positionsExcludingBestWin(
  positions: ProfitFactorPosition[]
): ProfitFactorPosition[] {
  let bestIdx = -1;
  let bestPnl = 0;
  for (let i = 0; i < positions.length; i++) {
    const pnl = positions[i].realizedPnl;
    if (pnl > bestPnl) {
      bestPnl = pnl;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestPnl <= 0) return positions;
  return positions.filter((_, i) => i !== bestIdx);
}

export function eligibleProfitFactorPositions(
  positions: ProfitFactorPosition[]
): ProfitFactorPosition[] {
  return positions.filter(
    (p) => !p.excludedFromStats && Number.isFinite(p.realizedPnl)
  );
}

export function computeWalletProfitFactorStats(
  positions: ProfitFactorPosition[]
): WalletProfitFactorStats {
  const eligible = eligibleProfitFactorPositions(positions);
  const overall = buildSlice("All", eligible);

  const byLabel = new Map<string, ProfitFactorPosition[]>();
  for (const p of eligible) {
    let label: string | null = null;
    if (p.hasReliableCategory && p.categoryLabel?.trim()) {
      label = p.categoryLabel.trim();
    } else if (p.hasReliableTitle && p.title?.trim()) {
      label = inferCategoryBadge(p.title).label;
    }
    if (!label) continue;
    const bucket = byLabel.get(label) ?? [];
    bucket.push(p);
    byLabel.set(label, bucket);
  }

  const byCategoryLabel = [...byLabel.entries()]
    .map(([label, rows]) => buildSlice(label, rows))
    .sort((a, b) => b.positionCount - a.positionCount);

  const { wins, losses } = winLossCountsFromPositions(eligible);

  return {
    availability: "verified",
    verified: true,
    overall,
    excludingBestTrade: null,
    byCategoryLabel,
    netRealizedPnl: overall.grossProfit - overall.grossLoss,
    headlineRealizedPnl: null,
    reconciliationGapPct: null,
    closedWinCount: wins,
    closedLossCount: losses,
    winRatePct: overall.winRatePct,
  };
}

export function profitFactorExcludingBestTradeSlice(
  positions: ProfitFactorPosition[]
): ProfitFactorSlice {
  const eligible = eligibleProfitFactorPositions(positions);
  return buildSlice("All (ex. best trade)", positionsExcludingBestWin(eligible));
}

export type ProfitFactorCategoryFilter =
  | "all"
  | MarketCategory
  | string;

const SPORTS_CATEGORY_LABELS = new Set([
  "WTA",
  "ATP",
  "MLB",
  "NBA",
  "NFL",
  "SOCCER",
  "ESPORTS",
  "SPORTS",
]);
const POLITICS_CATEGORY_LABELS = new Set(["CONGRESS", "FEDERAL", "POLITICS"]);
const CULTURE_CATEGORY_LABELS = new Set(["CULTURE"]);

export function filterPositionsByCategory(
  positions: ProfitFactorPosition[],
  category: ProfitFactorCategoryFilter
): ProfitFactorPosition[] {
  const eligible = eligibleProfitFactorPositions(positions);
  if (category === "all") return eligible;
  const tagged = eligible.filter(
    (p) =>
      (p.hasReliableCategory && p.categoryLabel?.trim()) ||
      (p.hasReliableTitle && p.title?.trim())
  );
  const coarse = new Set<MarketCategory>([
    "SPORTS",
    "POLITICS",
    "CULTURE",
    "CRYPTO",
    "MARKET",
  ]);
  if (coarse.has(category as MarketCategory)) {
    return tagged.filter((p) => {
      if (p.categoryLabel) {
        const c = p.categoryLabel.toUpperCase();
        if (category === "SPORTS") {
          return SPORTS_CATEGORY_LABELS.has(c);
        }
        if (category === "POLITICS") {
          return POLITICS_CATEGORY_LABELS.has(c);
        }
        if (category === "CULTURE") {
          return CULTURE_CATEGORY_LABELS.has(c);
        }
      }
      return (
        p.title &&
        inferMarketCategory(p.title) === (category as MarketCategory)
      );
    });
  }
  return tagged.filter(
    (p) =>
      (p.categoryLabel && p.categoryLabel === String(category)) ||
      (p.title && inferCategoryBadge(p.title).label === category)
  );
}

export function computeCategoryProfitFactorSlice(
  positions: ProfitFactorPosition[],
  category: ProfitFactorCategoryFilter
): ProfitFactorSlice {
  const filtered = filterPositionsByCategory(positions, category);
  if (category === "all") return buildSlice("All", filtered);
  const coarse = new Set<MarketCategory>([
    "SPORTS",
    "POLITICS",
    "CULTURE",
    "CRYPTO",
    "MARKET",
  ]);
  const label = coarse.has(category as MarketCategory)
    ? category === "SPORTS"
      ? "Sports"
      : category.charAt(0) + category.slice(1).toLowerCase()
    : String(category);
  return buildSlice(label, filtered);
}

function mergeProfitFactorSlices(
  slices: ProfitFactorSlice[],
  categoryLabel: string
): ProfitFactorSlice | null {
  if (slices.length === 0) return null;
  const grossProfit = slices.reduce((s, x) => s + x.grossProfit, 0);
  const grossLoss = slices.reduce((s, x) => s + x.grossLoss, 0);
  const positionCount = slices.reduce((s, x) => s + x.positionCount, 0);
  if (positionCount === 0) return null;
  const winCount = slices.reduce((s, x) => s + x.winCount, 0);
  const lossCount = slices.reduce((s, x) => s + x.lossCount, 0);
  return {
    categoryLabel,
    positionCount,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    profitFactorExBest: null,
    limitedData: positionCount < LIMITED_DATA_POSITION_FLOOR,
    winCount,
    lossCount,
    winRatePct: winRatePctFromCounts(winCount, lossCount),
  };
}

export function profitFactorSliceForCategoryFilter(
  stats: WalletProfitFactorStats | null | undefined,
  category: ProfitFactorCategoryFilter
): ProfitFactorSlice | null {
  if (!stats || stats.availability !== "verified" || !stats.overall) {
    return null;
  }
  if (category === "all") return stats.overall;

  if (category === "SPORTS") {
    return mergeProfitFactorSlices(
      stats.byCategoryLabel.filter((s) =>
        SPORTS_CATEGORY_LABELS.has(s.categoryLabel)
      ),
      "Sports"
    );
  }
  if (category === "POLITICS") {
    return mergeProfitFactorSlices(
      stats.byCategoryLabel.filter((s) =>
        POLITICS_CATEGORY_LABELS.has(s.categoryLabel)
      ),
      "Politics"
    );
  }
  if (category === "CULTURE") {
    return mergeProfitFactorSlices(
      stats.byCategoryLabel.filter((s) =>
        CULTURE_CATEGORY_LABELS.has(s.categoryLabel)
      ),
      "Culture"
    );
  }

  const badgeLabel = String(category);
  const exact = stats.byCategoryLabel.find(
    (s) => s.categoryLabel === badgeLabel
  );
  return exact && exact.positionCount > 0 ? exact : null;
}
