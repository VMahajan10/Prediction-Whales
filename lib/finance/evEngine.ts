/**
 * Real-time EV utilities — CLOB midpoint pricing, fee-adjusted EV, Kelly sizing.
 * Hot-path functions avoid allocations and use single-pass loops for WebSocket scale.
 */

export type EvPlatform = "polymarket" | "kalshi";

/** [price, size] — price in probability dollars (0–1), size in contracts/shares. */
export type OrderBookLevel = readonly [price: number, size: number];

export interface OrderBook {
  bids: readonly OrderBookLevel[];
  asks: readonly OrderBookLevel[];
}

export interface MidpointResult {
  /** Size-weighted microprice at the touch (preferred) or arithmetic mid. */
  midpoint: number;
  bestBid: number;
  bestAsk: number;
  bestBidSize: number;
  bestAskSize: number;
  spread: number;
  /** `microprice` when both sides have size; otherwise `arithmetic`. */
  method: "microprice" | "arithmetic";
}

export interface TrueEvBreakdown {
  /** Gross EV per $1 YES contract before fees: p_true - p_market. */
  grossEv: number;
  /** All-in EV per $1 YES contract after platform costs. */
  netEv: number;
  /** Total fee/slippage drag subtracted from gross EV. */
  feeDrag: number;
  pTrue: number;
  pMarketMidpoint: number;
  platform: EvPlatform;
}

export interface KellySizeResult {
  /** Optimal fraction of bankroll (0–1) after fractional scaling. */
  fraction: number;
  /** Full Kelly before fractional scaling. */
  fullKelly: number;
  /** Net odds b = (1 - p_market) / p_market. */
  odds: number;
  /** Inferred or supplied market price used for odds. */
  pMarket: number;
}

export interface PortfolioPosition {
  ev: number;
  allocation: number;
}

export interface PortfolioEvResult {
  /** Σ(ev_i × allocation_i). */
  totalEv: number;
  /** Sum of allocation weights. */
  totalAllocation: number;
  positionCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROB_EPS = 1e-9;
const KALSHI_TAKER_FEE_RATE = 0.07;
/** Polymarket: no exchange fee; model half-spread slippage in basis points. */
const POLYMARKET_SLIPPAGE_BPS = 10;
const DEFAULT_KELLY_FRACTION = 0.25;

// ---------------------------------------------------------------------------
// Helpers (inlined-friendly, no allocations)
// ---------------------------------------------------------------------------

function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  if (p <= PROB_EPS) return PROB_EPS;
  if (p >= 1 - PROB_EPS) return 1 - PROB_EPS;
  return p;
}

function kalshiTakerFeePerContract(price: number): number {
  const p = clampProb(price);
  return KALSHI_TAKER_FEE_RATE * p * (1 - p);
}

function polymarketSlippagePerContract(price: number): number {
  const p = clampProb(price);
  return (POLYMARKET_SLIPPAGE_BPS / 10_000) * p;
}

function scanBestBid(
  bids: readonly OrderBookLevel[]
): { price: number; size: number } | null {
  let bestPrice = -Infinity;
  let bestSize = 0;
  let found = false;

  for (let i = 0; i < bids.length; i++) {
    const price = bids[i][0];
    const size = bids[i][1];
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) {
      continue;
    }
    if (price > bestPrice) {
      bestPrice = price;
      bestSize = size;
      found = true;
    }
  }

  return found ? { price: bestPrice, size: bestSize } : null;
}

function scanBestAsk(
  asks: readonly OrderBookLevel[]
): { price: number; size: number } | null {
  let bestPrice = Infinity;
  let bestSize = 0;
  let found = false;

  for (let i = 0; i < asks.length; i++) {
    const price = asks[i][0];
    const size = asks[i][1];
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) {
      continue;
    }
    if (price < bestPrice) {
      bestPrice = price;
      bestSize = size;
      found = true;
    }
  }

  return found ? { price: bestPrice, size: bestSize } : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * CLOB midpoint from live bid/ask depth — not last trade.
 * Uses size-weighted microprice at the touch when both sides have liquidity;
 * falls back to arithmetic (bid + ask) / 2.
 */
export function calculateMidpoint(orderBook: OrderBook): MidpointResult | null {
  const bid = scanBestBid(orderBook.bids);
  const ask = scanBestAsk(orderBook.asks);
  if (!bid || !ask) return null;

  const bestBid = bid.price;
  const bestAsk = ask.price;
  if (bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) return null;

  const sizeSum = bid.size + ask.size;
  let midpoint: number;
  let method: MidpointResult["method"];

  if (sizeSum > 0) {
    midpoint = (bestBid * ask.size + bestAsk * bid.size) / sizeSum;
    method = "microprice";
  } else {
    midpoint = (bestBid + bestAsk) / 2;
    method = "arithmetic";
  }

  return {
    midpoint: clampProb(midpoint),
    bestBid,
    bestAsk,
    bestBidSize: bid.size,
    bestAskSize: ask.size,
    spread: bestAsk - bestBid,
    method,
  };
}

/** Fast midpoint scalar for hot paths (returns null if book is unusable). */
export function calculateMidpointPrice(orderBook: OrderBook): number | null {
  return calculateMidpoint(orderBook)?.midpoint ?? null;
}

/**
 * Standard binary YES EV per $1 face value:
 *   EV = p_true × (1 - p_market) - (1 - p_true) × p_market  ≡  p_true - p_market
 * Net EV subtracts platform-specific taker fees / slippage.
 */
export function calculateTrueEV(
  p_true: number,
  p_market_midpoint: number,
  platform: EvPlatform
): TrueEvBreakdown {
  const pTrue = clampProb(p_true);
  const pMarket = clampProb(p_market_midpoint);

  const grossEv = pTrue * (1 - pMarket) - (1 - pTrue) * pMarket;

  let feeDrag: number;
  switch (platform) {
    case "kalshi":
      feeDrag = kalshiTakerFeePerContract(pMarket);
      break;
    case "polymarket":
      feeDrag = polymarketSlippagePerContract(pMarket);
      break;
    default:
      feeDrag = 0;
  }

  return {
    grossEv,
    netEv: grossEv - feeDrag,
    feeDrag,
    pTrue,
    pMarketMidpoint: pMarket,
    platform,
  };
}

/** Scalar net EV helper for tight loops. */
export function calculateNetEv(
  p_true: number,
  p_market_midpoint: number,
  platform: EvPlatform
): number {
  return calculateTrueEV(p_true, p_market_midpoint, platform).netEv;
}

/**
 * Fractional Kelly criterion for a YES position:
 *   f* = (p × b - q) / b,  b = (1 - p_market) / p_market,  q = 1 - p
 *
 * When `pMarket` is omitted, infers p_market = p_true - ev (clamped).
 */
export function calculateKellySize(
  ev: number,
  p_true: number,
  options?: { pMarket?: number; fractional?: number }
): KellySizeResult {
  const pTrue = clampProb(p_true);
  const q = 1 - pTrue;
  const fractional = options?.fractional ?? DEFAULT_KELLY_FRACTION;

  let pMarket: number;
  if (options?.pMarket != null && Number.isFinite(options.pMarket)) {
    pMarket = clampProb(options.pMarket);
  } else {
    pMarket = clampProb(pTrue - ev);
  }

  const b = (1 - pMarket) / pMarket;
  const fullKelly = b > PROB_EPS ? (pTrue * b - q) / b : 0;
  const scaled = fullKelly > 0 ? fullKelly * fractional : 0;

  return {
    fraction: scaled > 1 ? 1 : scaled < 0 ? 0 : scaled,
    fullKelly: fullKelly < 0 ? 0 : fullKelly,
    odds: b,
    pMarket,
  };
}

/**
 * Portfolio aggregate EV: Σ(ev_i × allocation_i).
 * Allocations are portfolio weights (e.g. 0.05 = 5% of bankroll).
 */
export function calculatePortfolioEV(
  positions: readonly PortfolioPosition[]
): PortfolioEvResult {
  let totalEv = 0;
  let totalAllocation = 0;

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const ev = pos.ev;
    const alloc = pos.allocation;
    if (!Number.isFinite(ev) || !Number.isFinite(alloc)) continue;
    totalEv += ev * alloc;
    totalAllocation += alloc;
  }

  return {
    totalEv,
    totalAllocation,
    positionCount: positions.length,
  };
}
