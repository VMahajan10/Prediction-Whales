export const EXPLORER_MODE_KEY = "marketpulse_explorer_mode";
export const TOUR_ACTIVE_KEY = "marketpulse_tour_active";

export function getExplorerMode(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(EXPLORER_MODE_KEY) === "true";
}

export function setExplorerMode(enabled: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(EXPLORER_MODE_KEY, String(enabled));
}

export function setTourActive(active: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(TOUR_ACTIVE_KEY, String(active));
}

export interface Likelihood {
  label: string;
  color: "green" | "yellow" | "orange" | "red";
  bars: number;
}

export function getLikelihood(prob: number): Likelihood {
  if (prob > 0.85) {
    return { label: "Almost Certain", color: "green", bars: 5 };
  }
  if (prob > 0.65) {
    return { label: "Likely", color: "green", bars: 4 };
  }
  if (prob > 0.45) {
    return { label: "Toss Up", color: "yellow", bars: 3 };
  }
  if (prob > 0.25) {
    return { label: "Unlikely", color: "orange", bars: 2 };
  }
  if (prob > 0.1) {
    return { label: "Very Unlikely", color: "red", bars: 1 };
  }
  return { label: "Extremely Unlikely", color: "red", bars: 1 };
}

export function getPopularityLabel(volume: number): string {
  if (volume > 1_000_000) return "🔥 Very Popular";
  if (volume > 100_000) return "👥 Popular";
  if (volume > 10_000) return "📊 Active";
  if (volume > 0) return "🌱 New Market";
  return "💤 Low Activity";
}

export function getLiquidityLabel(spread: number | null): string {
  const s = spread ?? 0;
  if (s < 2) return "⚡ Easy to trade";
  if (s < 5) return "✅ Good liquidity";
  if (s < 10) return "⚠️ Moderate";
  return "🚨 Hard to trade";
}

export interface BeginnerAdvice {
  icon: string;
  text: string;
}

export function getBeginnerAdvice(
  prob: number,
  spread: number | null,
  volume: number
): BeginnerAdvice[] {
  const advice: BeginnerAdvice[] = [];
  const s = spread ?? 0;

  if (s > 10) {
    advice.push({
      icon: "⚠️",
      text: "Wide spread — this market is hard to trade in and out of. Not ideal for beginners.",
    });
  }

  if (volume === 0) {
    advice.push({
      icon: "💤",
      text: "Low activity market — thin trading may mean the price is stale or easy to move. Be careful.",
    });
  }

  if (prob > 0.85) {
    advice.push({
      icon: "💡",
      text: "High probability means low payout. You might win often but won't make much each time.",
    });
  }

  if (prob < 0.1) {
    advice.push({
      icon: "🎲",
      text: "Very low probability — this is a longshot. You'll lose most of the time, but the payout is huge if it happens.",
    });
  }

  if (prob > 0.4 && prob < 0.6) {
    advice.push({
      icon: "🪙",
      text: "Near 50/50 — the market is genuinely uncertain. This is where your own research can give you an edge.",
    });
  }

  if (volume > 1_000_000 && s < 3) {
    advice.push({
      icon: "✅",
      text: "High volume and tight spread — this is a well-traded market with reliable pricing. Good for beginners.",
    });
  }

  if (advice.length === 0) {
    advice.push({
      icon: "📊",
      text: "Review the probability and spread before placing a practice bet. Start small while you learn.",
    });
  }

  return advice;
}

export function getPositionNarrative(
  side: "YES" | "NO",
  entryPrice: number,
  currentPrice: number,
  pnl: number
): string {
  const moved = currentPrice - entryPrice;

  if (Math.abs(moved) < 0.005 && Math.abs(pnl) < 0.5) {
    return "The market hasn't moved much yet. Keep watching.";
  }

  if (side === "YES" && moved > 0) {
    return "The market moved in your favor. Implied probability is higher than when you entered.";
  }
  if (side === "YES" && moved < 0) {
    return "The market moved against you. Implied probability is lower than when you entered.";
  }
  if (side === "NO" && moved < 0) {
    return "The market moved in your favor. YES priced lower — good for your NO position.";
  }
  if (side === "NO" && moved > 0) {
    return "The market moved against you. YES priced higher — that hurts your NO bet.";
  }

  return pnl >= 0
    ? "Your position is doing well so far. Keep an eye on how the probability changes."
    : "Your position is down for now. Markets can move quickly — watch for changes.";
}

export const GLOSSARY_TERMS: { term: string; definition: string }[] = [
  {
    term: "Probability",
    definition:
      "Implied chance from market price — money-weighted by traders, not a vote count",
  },
  {
    term: "Spread",
    definition:
      "The difference between buying and selling price. Lower spread = easier to trade",
  },
  {
    term: "Volume",
    definition:
      "Total money bet on this market. Higher volume = more reliable price",
  },
  {
    term: "Position",
    definition:
      "A bet you currently have open that you haven't closed yet",
  },
  {
    term: "P&L",
    definition:
      "Profit and Loss — how much money you've made or lost on a trade",
  },
  {
    term: "Expected Value",
    definition:
      "The average profit or loss you'd expect over many identical bets",
  },
  {
    term: "Liquidity",
    definition:
      "How easy it is to buy or sell without moving the price much",
  },
  {
    term: "Resolution",
    definition:
      "When the event happens and the market pays out winners",
  },
];
