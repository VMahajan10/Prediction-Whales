import type { Market } from "@/lib/polymarket";

export interface AnalysisResult {
  summary: string;
  probabilityInsight: string;
  spreadInsight: string;
  volumeInsight: string;
  verdict: string;
  confidence: "High" | "Medium" | "Low";
}

function formatProbPct(probability: number): string {
  const pct = probability * 100;
  return pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1);
}

function getProbabilityInsight(probability: number): string {
  const prob = formatProbPct(probability);

  if (probability > 0.85) {
    return `Strong consensus — market participants overwhelmingly believe this will happen (${prob}%)`;
  }
  if (probability > 0.65) {
    return `Moderate lean toward YES — majority expect this outcome (${prob}%)`;
  }
  if (probability >= 0.45 && probability <= 0.65) {
    return `Too close to call — market is nearly split (${prob}%)`;
  }
  if (probability < 0.15) {
    return `Strong consensus against — very unlikely according to market (${prob}%)`;
  }
  if (probability < 0.35) {
    return `Market leans heavily NO — most participants doubt this outcome (${prob}%)`;
  }
  return `Market leans toward NO — participants skeptical of this outcome (${prob}%)`;
}

function getSpreadInsight(spread: number): string {
  const spreadStr = spread.toFixed(1);

  if (spread < 1) {
    return `Tight spread (${spreadStr}¢) — highly liquid market with active trading`;
  }
  if (spread < 3) {
    return `Normal spread (${spreadStr}¢) — healthy liquidity`;
  }
  if (spread < 10) {
    return `Wide spread (${spreadStr}¢) — moderate liquidity, use limit orders`;
  }
  return `Very wide spread (${spreadStr}¢) — low liquidity, tread carefully`;
}

function getVolumeInsight(market: Market): string {
  if (market.source === "predictit" || market.volume === 0) {
    return "";
  }

  const { volume } = market;

  if (volume > 1_000_000) {
    return `High volume market ($${(volume / 1_000_000).toFixed(1)}M) — strong price discovery`;
  }
  if (volume > 100_000) {
    return `Moderate volume ($${Math.round(volume / 1_000)}k) — reasonable confidence in price`;
  }
  return `Low volume ($${Math.round(volume)}) — price may not reflect true consensus`;
}

function getVerdict(probability: number, spread: number): string {
  let probPart: string;
  if (probability > 0.75) {
    probPart = "High-confidence YES";
  } else if (probability > 0.55) {
    probPart = "Moderate YES lean";
  } else if (probability >= 0.45 && probability <= 0.55) {
    probPart = "Uncertain outcome";
  } else if (probability < 0.25) {
    probPart = "High-confidence NO";
  } else {
    probPart = "Moderate NO lean";
  }

  const spreadPart =
    spread < 2
      ? "tight spread"
      : spread >= 10
        ? "wide spread"
        : "moderate spread";

  let action: string;
  if (spread < 2 && (probability > 0.75 || probability < 0.25)) {
    action = "well-priced market";
  } else if (spread >= 10 && probability >= 0.4 && probability <= 0.6) {
    action = "avoid unless you have edge";
  } else if (spread >= 10) {
    action = "tread carefully on position sizing";
  } else if (probability >= 0.45 && probability <= 0.55 && spread >= 3) {
    action = "avoid unless you have edge";
  } else {
    action = "reasonable for informed traders";
  }

  return `${probPart} with ${spreadPart} — ${action}`;
}

function getConfidence(market: Market, spread: number): AnalysisResult["confidence"] {
  if (market.source === "predictit") {
    if (spread < 2) return "High";
    if (spread > 10) return "Low";
    return "Medium";
  }

  const { volume } = market;
  if (spread < 2 && volume > 100_000) return "High";
  if (spread > 10 || volume < 1_000) return "Low";
  return "Medium";
}

export function generateAnalysis(market: Market): AnalysisResult {
  const spread = market.spread ?? 0;

  return {
    summary: `This market asks whether ${market.question}`,
    probabilityInsight: getProbabilityInsight(market.probability),
    spreadInsight: getSpreadInsight(spread),
    volumeInsight: getVolumeInsight(market),
    verdict: getVerdict(market.probability, spread),
    confidence: getConfidence(market, spread),
  };
}
