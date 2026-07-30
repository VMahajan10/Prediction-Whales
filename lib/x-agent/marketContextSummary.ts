import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const DEFAULT_CONTEXT_MODEL = "gpt-4o-mini";
const MAX_CONTEXT_CHARS = 220;

export interface MarketContextSummaryInput {
  title: string;
  marketPlain: string;
  side: string;
  slug?: string | null;
}

function isLlmConfigured(): boolean {
  return !!(
    process.env.OPENAI_API_KEY?.trim() || process.env.AI_GATEWAY_API_KEY?.trim()
  );
}

function resolveContextModel() {
  return process.env.X_AGENT_CONTEXT_MODEL?.trim() || DEFAULT_CONTEXT_MODEL;
}

function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * One-sentence matchup background for X post copy ({context} slot).
 * Returns null when the LLM is unavailable or the call fails.
 */
export async function generateMarketContextSummary(
  input: MarketContextSummaryInput
): Promise<string | null> {
  if (!isLlmConfigured()) {
    console.warn(
      "[x-agent/marketContextSummary] OPENAI_API_KEY missing — skipping context"
    );
    return null;
  }

  const title = input.title.trim() || input.marketPlain.trim();
  const marketPlain = input.marketPlain.trim();
  const side = input.side.trim();
  const slug = input.slug?.trim() || "";

  if (!title && !marketPlain) return null;

  const prompt = `You write concise background lines for prediction-market social posts.

Market title: ${title}
Plain-language market: ${marketPlain}
Whale action: ${side}
${slug ? `Slug: ${slug}` : ""}

Write exactly one short sentence (max 25 words) giving useful event context for readers who do not follow this market closely.
- No URLs, hashtags, emojis, or price quotes.
- No hype or calls to action.
- Plain English only.`;

  try {
    const { text } = await generateText({
      model: openai(resolveContextModel()),
      prompt,
      temperature: 0.3,
      maxOutputTokens: 80,
    });

    const cleaned = stripUrls(text.trim());
    if (!cleaned) return null;
    return cleaned.length > MAX_CONTEXT_CHARS
      ? `${cleaned.slice(0, MAX_CONTEXT_CHARS - 1).trim()}…`
      : cleaned;
  } catch (error) {
    console.warn("[x-agent/marketContextSummary] OpenAI call failed", {
      error: error instanceof Error ? error.message : error,
    });
    return null;
  }
}
