import { CREDIBILITY_CONFIG } from "@/lib/feedQualification";

/**
 * Templates.md §6 "Gates before copy":
 * "credibility floor (≥500 resolved, win rate threshold)"
 *
 * That floor applies to pre-copy **gates**, not template placeholder rendering.
 * The variable schema (§Variable schema) only requires `{resolved}` as a slot,
 * without a 500 minimum at the template layer.
 */
export const TEMPLATES_MD_GATE_RESOLVED_BETS_FLOOR = 500;

/**
 * Template-engine floor for `{resolved}` / credibility slots — matches upstream
 * x-agent credibility (`CREDIBILITY_CONFIG.MIN_RESOLVED_BETS`), not §6's 500.
 */
export const MIN_TEMPLATE_RESOLVED_BETS = CREDIBILITY_CONFIG.MIN_RESOLVED_BETS;

/**
 * Templates.md variable schema (lines 19–20): every post must have data for
 * `{whale}`, `{side}`, `{entry}`, and one credibility stat (`{avg_ev}` preferred,
 * else `{win_rate}` with `{resolved}`). Hard rule §7: missing slot → no post.
 * Example variants may omit some tokens from the visible sentence; gates still
 * require the underlying slots (`assertRequiredBaseSlots`).
 */
export const TEMPLATES_MD_GLOBAL_REQUIRED_SLOTS = [
  "whale",
  "side",
  "entry",
  "credibility(avg_ev|win_rate+resolved)",
] as const;
