import type { Market } from "@/lib/polymarket";

const STORAGE_KEY = "marketpulse_portfolio";
const STARTING_CASH = 1000;

export interface Position {
  id: string;
  marketId: string;
  question: string;
  source: "polymarket" | "kalshi";
  side: "YES" | "NO";
  shares: number;
  entryPrice: number;
  cost: number;
  timestamp: number;
  resolved: boolean;
  exitPrice?: number;
  pnl?: number;
}

export interface Portfolio {
  cash: number;
  positions: Position[];
}

function isClient(): boolean {
  return typeof window !== "undefined";
}

export function getPortfolio(): Portfolio {
  if (!isClient()) {
    return { cash: STARTING_CASH, positions: [] };
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { cash: STARTING_CASH, positions: [] };
    }
    const parsed = JSON.parse(raw) as Portfolio;
    return {
      cash: parsed.cash ?? STARTING_CASH,
      positions: Array.isArray(parsed.positions) ? parsed.positions : [],
    };
  } catch {
    return { cash: STARTING_CASH, positions: [] };
  }
}

export function savePortfolio(portfolio: Portfolio): void {
  if (!isClient()) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(portfolio));
}

export function getPositionValue(
  position: Position,
  currentProbability: number
): number {
  if (position.side === "YES") {
    return currentProbability * position.shares;
  }
  return (1 - currentProbability) * position.shares;
}

export function getPositionPnL(
  position: Position,
  currentProbability: number
): number {
  return getPositionValue(position, currentProbability) - position.cost;
}

export function buyPosition(
  market: Market,
  side: "YES" | "NO",
  dollarAmount: number,
  currentProbability: number
): { success: boolean; error?: string } {
  const portfolio = getPortfolio();

  if (dollarAmount > portfolio.cash) {
    return { success: false, error: "Insufficient funds" };
  }

  if (dollarAmount <= 0) {
    return { success: false, error: "Invalid amount" };
  }

  if (portfolio.positions.some((p) => p.marketId === market.id && !p.resolved)) {
    return { success: false, error: "Already have an open position on this market" };
  }

  const entryPrice =
    side === "YES" ? currentProbability : 1 - currentProbability;

  if (entryPrice <= 0) {
    return { success: false, error: "Invalid market price" };
  }

  const shares = dollarAmount / entryPrice;
  const cost = dollarAmount;

  const position: Position = {
    id: `${market.id}-${Date.now()}`,
    marketId: market.id,
    question: market.question,
    source: market.source,
    side,
    shares,
    entryPrice,
    cost,
    timestamp: Math.floor(Date.now() / 1000),
    resolved: false,
  };

  portfolio.cash -= cost;
  portfolio.positions.push(position);
  savePortfolio(portfolio);

  return { success: true };
}

export function closePosition(
  positionId: string,
  currentProbability: number
): void {
  const portfolio = getPortfolio();
  const position = portfolio.positions.find((p) => p.id === positionId);

  if (!position || position.resolved) return;

  const exitPrice =
    position.side === "YES"
      ? currentProbability
      : 1 - currentProbability;

  const pnl = (exitPrice - position.entryPrice) * position.shares;

  position.resolved = true;
  position.exitPrice = exitPrice;
  position.pnl = pnl;
  portfolio.cash += position.cost + pnl;

  savePortfolio(portfolio);
}

export function getOpenPositionForMarket(marketId: string): Position | null {
  const portfolio = getPortfolio();
  return (
    portfolio.positions.find((p) => p.marketId === marketId && !p.resolved) ??
    null
  );
}

export function resetPortfolio(): void {
  savePortfolio({ cash: STARTING_CASH, positions: [] });
}

export function getPortfolioStats(
  portfolio: Portfolio,
  probabilities: Record<string, number>
): {
  totalValue: number;
  cash: number;
  openCount: number;
  totalPnL: number;
} {
  let totalValue = portfolio.cash;
  let totalPnL = 0;

  for (const position of portfolio.positions) {
    if (!position.resolved) {
      const prob =
        probabilities[position.marketId] ??
        (position.side === "YES" ? position.entryPrice : 1 - position.entryPrice);
      const value = getPositionValue(position, prob);
      totalValue += value;
      totalPnL += getPositionPnL(position, prob);
    } else if (position.pnl != null) {
      totalPnL += position.pnl;
    }
  }

  const openCount = portfolio.positions.filter((p) => !p.resolved).length;

  return {
    totalValue,
    cash: portfolio.cash,
    openCount,
    totalPnL,
  };
}
