import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketSentimentResult {
  /** Directional impact on YES probability, strictly in [-1, 1]. */
  impactScore: number;
  /** LLM self-assessed reliability of the news/context grading, in [0, 1]. */
  reliability: number;
  reasoning: string;
  source: "llm" | "fallback";
}

export type BaselineModelKind = "weather" | "economic" | "market_microstructure";

export interface BaselineModelSignal {
  model: BaselineModelKind;
  /** Directional impact on YES probability, in [-1, 1]. */
  impactScore: number;
  /** Model confidence in [0, 1]. */
  confidence: number;
  payload: Record<string, unknown>;
}

export interface AgentProbabilityScore {
  label: string;
  /** Agent-implied YES probability after log-odds shift. */
  probability: number;
  weight: number;
  confidence: number;
}

export interface PTrueContributor {
  source: string;
  weight: number;
  impactScore: number;
  impliedProbability: number;
  confidence: number;
}

export interface PTrueResult {
  pTrue: number;
  variance: number;
  sourceScore: number;
  marketPrior: number;
  jensenShannonDivergence: number;
  shrinkageApplied: number;
  contributors: PTrueContributor[];
  sentiment: MarketSentimentResult;
  baselines: BaselineModelSignal[];
  usedFallback: boolean;
}

export interface CalculatePTrueInput {
  marketTitle: string;
  marketDescription?: string;
  /** Scraped mock news feed / event context for LLM grading. */
  marketContext: string;
  /** Market-implied YES probability used as the Bayesian prior (0–1). */
  marketPrior: number;
  /** Optional override baseline signals (otherwise simulated). */
  baselines?: BaselineModelSignal[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROB_EPS = 1e-6;
const LN2 = Math.LN2;
/** Max log-odds shift from a fully confident ±1 impact agent. */
const IMPACT_LOGIT_SCALE = 1.75;
const MAX_SHRINKAGE = 0.45;
const DEFAULT_PRIOR = 0.5;

const SentimentSchema = z.object({
  impactScore: z
    .number()
    .min(-1)
    .max(1)
    .describe(
      "Directional impact on the YES outcome: -1 = strongly decreases YES probability, +1 = strongly increases YES probability, 0 = neutral."
    ),
  reliability: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Confidence in this grading given source quality, recency, and relevance (0 = unusable, 1 = highly reliable)."
    ),
  reasoning: z
    .string()
    .max(500)
    .describe("One or two sentences explaining the score."),
});

const FALLBACK_SENTIMENT: MarketSentimentResult = {
  impactScore: 0,
  reliability: 0,
  reasoning: "LLM sentiment unavailable — using neutral impact fallback.",
  source: "fallback",
};

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

export function clampProbability(p: number, eps = PROB_EPS): number {
  if (!Number.isFinite(p)) return DEFAULT_PRIOR;
  return Math.min(1 - eps, Math.max(eps, p));
}

export function logit(p: number): number {
  const pc = clampProbability(p);
  return Math.log(pc / (1 - pc));
}

export function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function bernoulliPMF(p: number): [number, number] {
  const yes = clampProbability(p);
  return [1 - yes, yes];
}

function klDivergence(p: number[], q: number[]): number {
  let kl = 0;
  for (let i = 0; i < p.length; i++) {
    const pi = Math.max(PROB_EPS, p[i]);
    const qi = Math.max(PROB_EPS, q[i]);
    kl += pi * Math.log(pi / qi);
  }
  return kl;
}

/**
 * Jensen–Shannon divergence between Bernoulli(p) and Bernoulli(q).
 * Returns a value in [0, ln(2)].
 */
export function jensenShannonDivergenceBernoulli(p: number, q: number): number {
  const P = bernoulliPMF(p);
  const Q = bernoulliPMF(q);
  const M: [number, number] = [
    0.5 * (P[0] + Q[0]),
    0.5 * (P[1] + Q[1]),
  ];
  return 0.5 * klDivergence(P, M) + 0.5 * klDivergence(Q, M);
}

/**
 * Mean JS divergence of each agent vs weighted consensus, normalized to [0, 1].
 */
export function meanNormalizedAgentDivergence(
  agents: AgentProbabilityScore[]
): number {
  if (agents.length <= 1) return 0;

  const weightSum = agents.reduce((s, a) => s + a.weight * a.confidence, 0);
  const consensus =
    weightSum > 0
      ? agents.reduce(
          (s, a) => s + a.probability * a.weight * a.confidence,
          0
        ) / weightSum
      : DEFAULT_PRIOR;

  let total = 0;
  for (const agent of agents) {
    total += jensenShannonDivergenceBernoulli(agent.probability, consensus);
  }

  const meanJs = total / agents.length;
  return Math.min(1, Math.max(0, meanJs / LN2));
}

function impactToProbability(
  prior: number,
  impactScore: number,
  confidence: number
): number {
  const shift = IMPACT_LOGIT_SCALE * impactScore * confidence;
  return clampProbability(sigmoid(logit(prior) + shift));
}

function weightedMeanAndVariance(
  values: number[],
  weights: number[]
): { mean: number; variance: number } {
  const wSum = weights.reduce((a, b) => a + b, 0);
  if (wSum <= 0 || values.length === 0) {
    return { mean: DEFAULT_PRIOR, variance: 0.25 };
  }

  const mean =
    values.reduce((s, v, i) => s + v * weights[i], 0) / wSum;
  const variance =
    values.reduce((s, v, i) => s + weights[i] * (v - mean) ** 2, 0) / wSum;

  return { mean: clampProbability(mean), variance: Math.max(0, variance) };
}

function clampSigned(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(-1, Math.min(1, x));
}

function clampUnit(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

// ---------------------------------------------------------------------------
// LLM sentiment
// ---------------------------------------------------------------------------

function resolveLanguageModel() {
  const modelId = process.env.PROBABILITY_LLM_MODEL ?? "gpt-4o";
  return openai(modelId);
}

function isLlmConfigured(): boolean {
  return !!(
    process.env.OPENAI_API_KEY?.trim() || process.env.AI_GATEWAY_API_KEY?.trim()
  );
}

/**
 * Grades scraped news/context for directional impact on a specific market event.
 * Returns neutral fallback if the LLM call fails.
 */
export async function fetchMarketSentiment(
  marketContext: string,
  meta?: { title?: string; description?: string }
): Promise<MarketSentimentResult> {
  if (!isLlmConfigured()) {
    console.warn(
      "[probabilityEngine] OPENAI_API_KEY missing — sentiment fallback"
    );
    return FALLBACK_SENTIMENT;
  }

  const title = meta?.title ?? "Unknown market";
  const description = meta?.description ?? "";

  const prompt = `You are a prediction-market research analyst.

Grade the reliability-weighted directional impact of the following news/context on the YES outcome of this market.

Market title: ${title}
Market description: ${description || "(none)"}

News / context feed:
"""
${marketContext.slice(0, 6000)}
"""

Instructions:
- impactScore: float in [-1, 1]. Positive = context increases YES probability; negative = decreases YES.
- reliability: float in [0, 1]. How trustworthy and relevant is this context for this specific market?
- Ignore unrelated noise. If context is empty or irrelevant, use impactScore=0 and low reliability.
- Do NOT output a final probability — only directional impact and reliability.`;

  try {
    const { object } = await generateObject({
      model: resolveLanguageModel(),
      schema: SentimentSchema,
      prompt,
      temperature: 0.2,
    });

    return {
      impactScore: clampSigned(object.impactScore),
      reliability: clampUnit(object.reliability),
      reasoning: object.reasoning,
      source: "llm",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[probabilityEngine] fetchMarketSentiment failed:", message);
    return {
      ...FALLBACK_SENTIMENT,
      reasoning: `LLM error: ${message.slice(0, 180)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Simulated baseline models (weather / economic / microstructure)
// ---------------------------------------------------------------------------

export function simulateBaselineSignals(input: {
  marketTitle: string;
  marketDescription?: string;
  marketPrior: number;
}): BaselineModelSignal[] {
  const text = `${input.marketTitle} ${input.marketDescription ?? ""}`.toLowerCase();
  const prior = clampProbability(input.marketPrior);
  const signals: BaselineModelSignal[] = [];

  if (/rain|snow|weather|temperature|hurricane|forecast|precip/.test(text)) {
    signals.push({
      model: "weather",
      impactScore: clampSigned((Math.random() - 0.5) * 0.6),
      confidence: 0.55,
      payload: {
        simulated: true,
        forecastDeviationF: Number(((Math.random() - 0.5) * 8).toFixed(1)),
        precipitationPct: Number((Math.random() * 100).toFixed(0)),
        note: "Mock weather baseline — replace with live NOAA/API feed.",
      },
    });
  }

  if (
    /fed|cpi|inflation|gdp|jobs|unemployment|rate cut|rate hike|recession|tariff|econom/.test(
      text
    )
  ) {
    signals.push({
      model: "economic",
      impactScore: clampSigned((Math.random() - 0.5) * 0.5),
      confidence: 0.6,
      payload: {
        simulated: true,
        macroSurpriseIndex: Number(((Math.random() - 0.5) * 2).toFixed(2)),
        deviationFromConsensusPct: Number(
          ((Math.random() - 0.5) * 1.5).toFixed(2)
        ),
        note: "Mock economic baseline — replace with structured macro data feed.",
      },
    });
  }

  signals.push({
    model: "market_microstructure",
    impactScore: clampSigned((prior - 0.5) * -0.15),
    confidence: 0.35,
    payload: {
      simulated: true,
      marketPrior: prior,
      meanReversionBias: true,
      note: "Light mean-reversion prior from current implied price.",
    },
  });

  return signals;
}

// ---------------------------------------------------------------------------
// Bayesian ensemble aggregation
// ---------------------------------------------------------------------------

export function aggregateAgentScores(input: {
  marketPrior: number;
  sentiment: MarketSentimentResult;
  baselines: BaselineModelSignal[];
}): {
  pTrue: number;
  variance: number;
  sourceScore: number;
  jensenShannonDivergence: number;
  shrinkageApplied: number;
  contributors: PTrueContributor[];
  agents: AgentProbabilityScore[];
} {
  const prior = clampProbability(input.marketPrior);
  const agents: AgentProbabilityScore[] = [];

  const sentimentWeight = input.sentiment.source === "llm" ? 1 : 0;
  if (sentimentWeight > 0 || input.sentiment.reliability > 0) {
    agents.push({
      label: "llm_sentiment",
      probability: impactToProbability(
        prior,
        input.sentiment.impactScore,
        input.sentiment.reliability
      ),
      weight: sentimentWeight || 0.25,
      confidence: input.sentiment.reliability,
    });
  }

  for (const baseline of input.baselines) {
    const baselineWeight =
      baseline.model === "weather"
        ? 0.85
        : baseline.model === "economic"
          ? 0.9
          : 0.4;

    agents.push({
      label: baseline.model,
      probability: impactToProbability(
        prior,
        baseline.impactScore,
        baseline.confidence
      ),
      weight: baselineWeight,
      confidence: baseline.confidence,
    });
  }

  if (agents.length === 0) {
    return {
      pTrue: prior,
      variance: 0.25,
      sourceScore: 0,
      jensenShannonDivergence: 0,
      shrinkageApplied: 0,
      contributors: [],
      agents: [],
    };
  }

  const weights = agents.map((a) => a.weight * a.confidence);
  const probabilities = agents.map((a) => a.probability);
  const { mean: consensus, variance } = weightedMeanAndVariance(
    probabilities,
    weights
  );

  const normalizedJs = meanNormalizedAgentDivergence(agents);
  const shrinkage = Math.min(MAX_SHRINKAGE, normalizedJs * MAX_SHRINKAGE * 2);
  const pTrue = clampProbability(
    (1 - shrinkage) * consensus + shrinkage * prior
  );

  const weightSum = weights.reduce((a, b) => a + b, 0);
  const sourceScore =
    weightSum > 0
      ? agents.reduce(
          (s, a, i) => s + a.confidence * (weights[i] / weightSum),
          0
        )
      : 0;

  const contributors: PTrueContributor[] = [
    {
      source: "llm_sentiment",
      weight: sentimentWeight,
      impactScore: input.sentiment.impactScore,
      impliedProbability:
        agents.find((a) => a.label === "llm_sentiment")?.probability ?? prior,
      confidence: input.sentiment.reliability,
    },
    ...input.baselines.map((b) => ({
      source: b.model,
      weight:
        b.model === "weather" ? 0.85 : b.model === "economic" ? 0.9 : 0.4,
      impactScore: b.impactScore,
      impliedProbability:
        agents.find((a) => a.label === b.model)?.probability ?? prior,
      confidence: b.confidence,
    })),
  ];

  return {
    pTrue,
    variance,
    sourceScore: clampUnit(sourceScore),
    jensenShannonDivergence: normalizedJs,
    shrinkageApplied: shrinkage,
    contributors,
    agents,
  };
}

/**
 * End-to-end p_true calculation: LLM sentiment + baseline models + Bayesian/JS merge.
 */
export async function calculatePTrue(
  input: CalculatePTrueInput
): Promise<PTrueResult> {
  const marketPrior = clampProbability(input.marketPrior);

  const sentiment = await fetchMarketSentiment(input.marketContext, {
    title: input.marketTitle,
    description: input.marketDescription,
  });

  const baselines =
    input.baselines ??
    simulateBaselineSignals({
      marketTitle: input.marketTitle,
      marketDescription: input.marketDescription,
      marketPrior,
    });

  const aggregated = aggregateAgentScores({
    marketPrior,
    sentiment,
    baselines,
  });

  return {
    pTrue: aggregated.pTrue,
    variance: aggregated.variance,
    sourceScore: aggregated.sourceScore,
    marketPrior,
    jensenShannonDivergence: aggregated.jensenShannonDivergence,
    shrinkageApplied: aggregated.shrinkageApplied,
    contributors: aggregated.contributors,
    sentiment,
    baselines,
    usedFallback: sentiment.source === "fallback",
  };
}
