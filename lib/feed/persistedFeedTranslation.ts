import {
  translateWhaleTradeMarket,
  type MarketPositionTranslation,
  type WhaleTradeTranslationInput,
} from "@/lib/marketTranslator";

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Extract strict translator input from a persisted Polymarket feed payload. */
export function polymarketTranslationInputFromPayload(
  payload: unknown
): WhaleTradeTranslationInput | null {
  if (!payload || typeof payload !== "object") return null;

  const row = payload as Record<string, unknown>;
  const title = readString(row.title);
  const outcome = readString(row.outcome);
  if (!title || !outcome) return null;

  return {
    title,
    outcome,
    side: row.side === "SELL" ? "SELL" : "BUY",
    slug: readString(row.slug),
    eventSlug: readString(row.eventSlug),
    endDate: readString(row.endDate),
    outcomes: Array.isArray(row.outcomes)
      ? row.outcomes.filter((value): value is string => typeof value === "string")
      : undefined,
  };
}

/** Current strict translator result for a persisted Polymarket payload, or null. */
export function resolveStrictPolymarketTranslationFromPayload(
  payload: unknown
): MarketPositionTranslation | null {
  const input = polymarketTranslationInputFromPayload(payload);
  if (!input) return null;
  return translateWhaleTradeMarket(input);
}

function translationsMatch(
  left: MarketPositionTranslation,
  right: MarketPositionTranslation
): boolean {
  return (
    left.backingLabel === right.backingLabel &&
    left.sideName === right.sideName &&
    (left.exitByLabel ?? "") === (right.exitByLabel ?? "")
  );
}

/**
 * Re-validate a persisted Polymarket feed payload with the current strict
 * translator. Never trusts `payload.marketTranslation`.
 */
export function revalidatePersistedPolymarketFeedPayload<
  T extends Record<string, unknown>,
>(
  payload: unknown
): (T & { marketTranslation: MarketPositionTranslation }) | null {
  if (!payload || typeof payload !== "object") return null;

  const translation = resolveStrictPolymarketTranslationFromPayload(payload);
  if (!translation) return null;

  return {
    ...(payload as T),
    marketTranslation: translation,
  };
}

export type PersistedTranslationCleanupAction =
  | "unchanged"
  | "retranslated"
  | "rejected";

export function classifyPersistedPolymarketTranslation(
  payload: unknown
): {
  action: PersistedTranslationCleanupAction;
  translation: MarketPositionTranslation | null;
} {
  const current = resolveStrictPolymarketTranslationFromPayload(payload);
  if (!current) {
    return { action: "rejected", translation: null };
  }

  if (!payload || typeof payload !== "object") {
    return { action: "retranslated", translation: current };
  }

  const stored = (payload as Record<string, unknown>).marketTranslation;
  if (!stored || typeof stored !== "object") {
    return { action: "retranslated", translation: current };
  }

  const storedTranslation = stored as MarketPositionTranslation;
  if (
    typeof storedTranslation.backingLabel !== "string" ||
    typeof storedTranslation.sideName !== "string"
  ) {
    return { action: "retranslated", translation: current };
  }

  if (translationsMatch(storedTranslation, current)) {
    return { action: "unchanged", translation: current };
  }

  return { action: "retranslated", translation: current };
}
