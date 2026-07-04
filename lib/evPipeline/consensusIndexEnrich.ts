import {
  outcomeMatchId,
  type OutcomeBooks,
  type OutcomeSide,
} from "@/lib/crossMarketEv";

const PROP_OUTCOMES = new Set(["over", "under", "yes", "no"]);

function normalizePropOutcome(label: string): string {
  const clean = label.toLowerCase().trim();
  if (clean === "over" || clean === "total_over" || clean === "o") return "over";
  if (clean === "under" || clean === "total_under" || clean === "u") return "under";
  if (clean === "yes" || clean === "true") return "yes";
  if (clean === "no" || clean === "false") return "no";
  return clean;
}

function propAliasId(baseId: string, normalizedOutcome: string): string {
  return `${baseId}|prop:${normalizedOutcome}`;
}

function normalizedPropFromEntry(
  entry: OutcomeBooks,
  matchId: string
): string | null {
  const label = entry.label.toLowerCase();
  const suffix = matchId.split("|").pop() ?? "";

  if (label.includes("total_over") || /\btotal\s+over\b/.test(label)) {
    return "over";
  }
  if (label.includes("total_under") || /\btotal\s+under\b/.test(label)) {
    return "under";
  }
  if (/\bover\b/.test(label) && !/\bunder\b/.test(label)) return "over";
  if (/\bunder\b/.test(label)) return "under";
  if (/\byes\b/.test(label) && !/\bno\b/.test(label)) return "yes";
  if (/\bno\b/.test(label)) return "no";

  const normalized = normalizePropOutcome(suffix);
  return PROP_OUTCOMES.has(normalized) ? normalized : null;
}

/**
 * Duplicate index entries under prop-level alias keys so fuzzy prop matchers
 * can resolve over/under without exact moneyline match ids.
 */
export function enrichConsensusIndexWithPropKeys(
  index: Map<string, OutcomeBooks>
): Map<string, OutcomeBooks> {
  const enriched = new Map(index);

  for (const [matchId, entry] of Array.from(index.entries())) {
    if (!entry.sportsbook?.bid || !entry.sportsbook?.ask) continue;

    const propOutcome = normalizedPropFromEntry(entry, matchId);
    if (!propOutcome) continue;

    const aliasId = propAliasId(matchId, propOutcome);
    if (!enriched.has(aliasId)) {
      enriched.set(aliasId, {
        ...entry,
        label: `${entry.label} [prop:${propOutcome}]`,
      });
    }

    for (const side of ["team_a", "team_b", "draw"] as OutcomeSide[]) {
      const baseId = outcomeMatchId(entry.game, side);
      if (baseId === matchId) continue;
      const sideAlias = propAliasId(baseId, propOutcome);
      if (!enriched.has(sideAlias) && enriched.has(baseId)) {
        enriched.set(sideAlias, {
          ...entry,
          outcome: side,
          label: `${entry.label} [prop:${propOutcome}]`,
        });
      }
    }
  }

  return enriched;
}
