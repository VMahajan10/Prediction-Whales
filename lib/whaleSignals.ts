export interface WhaleSignal {
  emoji: string;
  label: string;
  plain: string;
  positive: boolean | null;
}

export interface CopyVerdict {
  verdict: string;
  verdictColor: "green" | "yellow" | "orange" | "red";
  verdictEmoji: string;
}

export function getSizeSignal(size: number): WhaleSignal {
  if (size >= 5000) {
    return {
      emoji: "✅",
      label: "Massive bet",
      plain: `$${size.toLocaleString()} — this is top 1% of all trades. Serious money.`,
      positive: true,
    };
  }
  if (size >= 1000) {
    return {
      emoji: "✅",
      label: "Large bet",
      plain: `$${size.toLocaleString()} — well above average. Shows conviction.`,
      positive: true,
    };
  }
  if (size >= 500) {
    return {
      emoji: "⚠️",
      label: "Moderate bet",
      plain: `$${size.toLocaleString()} — above the $500 whale threshold but not exceptional.`,
      positive: null,
    };
  }
  return {
    emoji: "❌",
    label: "Small bet",
    plain: `$${size.toLocaleString()} — below typical whale size. Lower conviction signal.`,
    positive: false,
  };
}

export function getPriceSignal(
  entryPrice: number,
  currentProb: number | null,
  side: "BUY" | "SELL"
): WhaleSignal {
  if (currentProb == null) {
    return {
      emoji: "📊",
      label: "Price data unavailable",
      plain: "Could not find current market price.",
      positive: null,
    };
  }

  const delta = currentProb - entryPrice;

  if (side === "BUY") {
    if (delta > 0.03) {
      return {
        emoji: "✅",
        label: "Market confirmed the bet",
        plain: `Whale bought at ${(entryPrice * 100).toFixed(1)}%. Market now at ${(currentProb * 100).toFixed(1)}%. Price moved ${(delta * 100).toFixed(1)}% in their favor — the market repriced upward.`,
        positive: true,
      };
    }
    if (Math.abs(delta) < 0.01) {
      return {
        emoji: "⏳",
        label: "Market hasn't reacted yet",
        plain: `Price unchanged since the whale bet. You can still enter at the same ${(currentProb * 100).toFixed(1)}% odds.`,
        positive: null,
      };
    }
    if (delta < -0.03) {
      return {
        emoji: "⚠️",
        label: "Price moved against the whale",
        plain: `Market dropped ${(Math.abs(delta) * 100).toFixed(1)}% since this bet. Price moved against the whale — proceed with caution.`,
        positive: false,
      };
    }
    return {
      emoji: "📊",
      label: "Mixed price signal",
      plain: `Market moved ${(delta * 100).toFixed(1)}% since entry. No strong confirmation either way.`,
      positive: null,
    };
  }

  return {
    emoji: "🔄",
    label: "Sell order",
    plain: "This is a sell, not a new buy. Price movement is less relevant for copy signals.",
    positive: null,
  };
}

export function getTimingSignal(timestamp: number): WhaleSignal {
  const minutesAgo = Math.floor((Date.now() / 1000 - timestamp) / 60);

  if (minutesAgo < 5) {
    return {
      emoji: "✅",
      label: "Fresh signal",
      plain: `Placed ${minutesAgo} minute${minutesAgo !== 1 ? "s" : ""} ago. You can still get similar odds.`,
      positive: true,
    };
  }
  if (minutesAgo < 30) {
    return {
      emoji: "⚠️",
      label: "Recent signal",
      plain: `Placed ${minutesAgo} minutes ago. Odds may have shifted slightly.`,
      positive: null,
    };
  }
  return {
    emoji: "❌",
    label: "Stale signal",
    plain: `Placed ${minutesAgo} minutes ago. The opportunity window may have passed.`,
    positive: false,
  };
}

export function getLiquiditySignal(
  spread: number | null,
  volume: number
): WhaleSignal {
  if (spread == null) {
    return {
      emoji: "📊",
      label: "Liquidity unknown",
      plain: "Could not find spread data for this market.",
      positive: null,
    };
  }

  if (spread < 2 && volume > 100000) {
    return {
      emoji: "✅",
      label: "Easy to copy",
      plain: `Tight ${spread.toFixed(1)}¢ spread and $${(volume / 1000).toFixed(0)}k volume. Your bet won't move the price.`,
      positive: true,
    };
  }
  if (spread < 5) {
    return {
      emoji: "⚠️",
      label: "Moderate liquidity",
      plain: `${spread.toFixed(1)}¢ spread. Decent liquidity but larger bets may shift odds slightly.`,
      positive: null,
    };
  }
  return {
    emoji: "❌",
    label: "Illiquid market",
    plain: `Wide ${spread.toFixed(1)}¢ spread. Copying this bet may cost you more than the whale paid.`,
    positive: false,
  };
}

export function getDirectionSignal(
  price: number,
  side: "BUY" | "SELL"
): WhaleSignal {
  if (side === "BUY" && price < 0.15) {
    return {
      emoji: "🎲",
      label: "High-risk longshot",
      plain: `Only ${(price * 100).toFixed(0)}% probability. Huge payout if correct but will lose most of the time.`,
      positive: null,
    };
  }
  if (side === "BUY" && price > 0.75) {
    return {
      emoji: "✅",
      label: "High-confidence bet",
      plain: `${(price * 100).toFixed(0)}% probability. Lower payout but high chance of winning.`,
      positive: true,
    };
  }
  if (side === "SELL") {
    return {
      emoji: "🔄",
      label: "Exit signal",
      plain: "Whale is selling, not buying. They may be taking profit or cutting losses — not a copy signal.",
      positive: false,
    };
  }
  return {
    emoji: "📊",
    label: "Balanced bet",
    plain: `${(price * 100).toFixed(0)}% probability. Neither extreme — worth researching the market.`,
    positive: null,
  };
}

export function calculateCopyVerdict(signals: WhaleSignal[]): CopyVerdict {
  const positiveCount = signals.filter((s) => s.positive === true).length;
  const negativeCount = signals.filter((s) => s.positive === false).length;

  if (positiveCount >= 3 && negativeCount === 0) {
    return {
      verdict: "Strong Copy Signal",
      verdictColor: "green",
      verdictEmoji: "🟢",
    };
  }
  if (positiveCount >= 2 && negativeCount <= 1) {
    return {
      verdict: "Worth Considering",
      verdictColor: "yellow",
      verdictEmoji: "🟡",
    };
  }
  if (negativeCount >= 2) {
    return {
      verdict: "Proceed With Caution",
      verdictColor: "orange",
      verdictEmoji: "🟠",
    };
  }
  return {
    verdict: "Weak Signal",
    verdictColor: "red",
    verdictEmoji: "🔴",
  };
}

export const VERDICT_BADGE_CLASSES: Record<CopyVerdict["verdictColor"], string> =
  {
    green: "bg-green-500/20 text-green-400 border-green-500/40",
    yellow: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40",
    orange: "bg-orange-500/20 text-orange-400 border-orange-500/40",
    red: "bg-red-500/20 text-red-400 border-red-500/40",
  };
