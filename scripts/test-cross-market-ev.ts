/**
 * Live cross-market EV verification — run with:
 *   npx tsx scripts/test-cross-market-ev.ts
 */
import { getUnmatchedTeamCodes } from "../lib/teamCodes";
import {
  buildCrossMarketBookIndex,
  gameMatchId,
  outcomeMatchId,
  snapshotGameEv,
  type OutcomeBooks,
  type OutcomeSide,
} from "../lib/crossMarketEv";

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function fmtProb(n: number | null): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(1)}¢`;
}

function pickShowcaseGames(
  index: Map<string, OutcomeBooks>
): OutcomeBooks[] {
  const all = Array.from(index.values()).filter(
    (e) => e.kalshi?.mid != null && e.polymarket?.mid != null
  );

  const preMatch = all.filter((e) => {
    const snap = snapshotGameEv(e);
    return snap.preKickoff && !snap.potentiallyInPlay;
  });

  const inPlayZone = all.filter((e) => {
    const snap = snapshotGameEv(e);
    return snap.potentiallyInPlay && !snap.preKickoff;
  });

  const picks: OutcomeBooks[] = [];
  const used = new Set<string>();

  const add = (e: OutcomeBooks | undefined) => {
    if (!e) return;
    const id = outcomeMatchId(e.game, e.outcome);
    if (used.has(id)) return;
    used.add(id);
    picks.push(e);
  };

  add(preMatch.find((e) => e.outcome === "team_a"));
  add(preMatch.find((e) => e.outcome === "team_b"));
  add(preMatch.find((e) => (snapshotGameEv(e).gap ?? 1) < 0.02));
  add(inPlayZone.find((e) => e.outcome === "team_a"));
  add(inPlayZone.find((e) => e.outcome === "team_b"));

  for (const e of preMatch) {
    if (picks.length >= 5) break;
    add(e);
  }
  for (const e of inPlayZone) {
    if (picks.length >= 5) break;
    add(e);
  }

  return picks.slice(0, 5);
}

async function showTargeted(
  index: Map<string, OutcomeBooks>,
  nowSec: number
) {
  const targets: Array<[string, string, string, OutcomeSide]> = [
    ["2026-06-17", "POR", "COD", "team_a"],
    ["2026-06-18", "CAN", "QAT", "team_a"],
    ["2026-06-23", "ENG", "GHA", "team_a"],
    ["2026-06-25", "TUR", "USA", "team_a"],
    ["2026-06-26", "SEN", "IRQ", "team_a"],
  ];

  console.log("=== TARGETED GAMES (in-play guard check) ===\n");

  for (const [date, a, b, outcome] of targets) {
    const id = `${date}|${a}|${b}|${outcome}`;
    const entry = index.get(id);
    if (!entry) {
      console.log(`--- ${date} ${a} v ${b} (${outcome}): NO MATCH ---\n`);
      continue;
    }
    const snap = snapshotGameEv(entry, nowSec);
    const status = snap.preKickoff
      ? "PRE-KICKOFF"
      : snap.potentiallyInPlay
        ? "IN-PLAY ZONE"
        : "UNKNOWN";

    console.log(`--- ${entry.label} [${status}] ---`);
    console.log(
      `  PM mid: ${fmtProb(snap.pmMid)}  Kalshi mid: ${fmtProb(snap.kalshiMid)}  gap: ${snap.gap != null ? `${(snap.gap * 100).toFixed(1)}¢` : "—"}`
    );
    console.log(
      `  EV buy PM: ${fmtPct(snap.evIfBuyOnPm.ev)}  reason=${snap.evIfBuyOnPm.reason}`
    );
    const kickoff = entry.game.kickoffEpochSec
      ? new Date(entry.game.kickoffEpochSec * 1000).toISOString()
      : "unknown";
    console.log(`  Kickoff: ${kickoff}`);
    console.log(
      `  Guard: ${snap.evIfBuyOnPm.reason === "ok" ? "SHOW" : `SUPPRESS (${snap.evIfBuyOnPm.reason})`}`
    );
    console.log();
  }
}

function showInPlayScan(
  index: Map<string, OutcomeBooks>,
  nowSec: number
) {
  const byGame = new Map<string, OutcomeBooks[]>();
  for (const e of Array.from(index.values())) {
    const gid = gameMatchId(e.game);
    const list = byGame.get(gid) ?? [];
    list.push(e);
    byGame.set(gid, list);
  }

  const inPlayGames: Array<{
    gid: string;
    entry: OutcomeBooks;
    snap: ReturnType<typeof snapshotGameEv>;
  }> = [];

  for (const [gid, entries] of Array.from(byGame.entries())) {
    const entry = entries.find((e: OutcomeBooks) => e.outcome === "team_a") ?? entries[0];
    const snap = snapshotGameEv(entry, nowSec);
    if (snap.potentiallyInPlay && !snap.preKickoff) {
      inPlayGames.push({ gid, entry, snap });
    }
  }

  console.log("=== IN-PLAY ZONE SCAN ===\n");
  console.log(`Games in kickoff window: ${inPlayGames.length}\n`);

  for (const { gid, entry, snap } of inPlayGames.slice(0, 5)) {
    const kickoff = entry.game.kickoffEpochSec
      ? new Date(entry.game.kickoffEpochSec * 1000).toISOString()
      : "unknown";
    const pmAge =
      entry.polymarket?.quoteUpdatedAt != null
        ? nowSec - entry.polymarket.quoteUpdatedAt
        : null;
    const kAge =
      entry.kalshi?.quoteUpdatedAt != null
        ? nowSec - entry.kalshi.quoteUpdatedAt
        : null;

    console.log(`--- ${gid} kickoff=${kickoff} ---`);
    console.log(
      `  PM mid: ${fmtProb(snap.pmMid)} (age ${pmAge ?? "—"}s, spread ${entry.polymarket?.spread != null ? `${(entry.polymarket.spread * 100).toFixed(0)}¢` : "—"})`
    );
    console.log(
      `  Kalshi mid: ${fmtProb(snap.kalshiMid)} (age ${kAge ?? "—"}s, spread ${entry.kalshi?.spread != null ? `${(entry.kalshi.spread * 100).toFixed(0)}¢` : "—"})`
    );
    console.log(
      `  Gap: ${snap.gap != null ? `${(snap.gap * 100).toFixed(1)}¢` : "—"}  EV reason=${snap.evIfBuyOnPm.reason}  Guard=${snap.evIfBuyOnPm.reason === "ok" ? "SHOW" : `SUPPRESS (${snap.evIfBuyOnPm.reason})`}`
    );
    console.log();
  }
}

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);
  console.log("Building cross-market book index (Kalshi KXWCGAME + PM fifwc)…\n");
  console.log(`Now: ${new Date(nowSec * 1000).toISOString()}\n`);

  const index = await buildCrossMarketBookIndex();
  const games = new Set<string>();
  for (const e of Array.from(index.values())) games.add(gameMatchId(e.game));

  console.log(`Matched games in index: ${games.size}`);
  console.log(`Outcome rows (kalshi+pm): ${index.size}\n`);

  showInPlayScan(index, nowSec);
  await showTargeted(index, nowSec);

  const picks = pickShowcaseGames(index);
  if (picks.length === 0) {
    console.log("No matched games with both books found.");
    process.exit(1);
  }

  console.log("=== 5 GAME SNAPSHOTS ===\n");

  picks.forEach((entry, i) => {
    const snap = snapshotGameEv(entry, nowSec);
    const status = snap.preKickoff
      ? "PRE-KICKOFF"
      : snap.potentiallyInPlay
        ? "IN-PLAY ZONE"
        : "UNKNOWN";

    console.log(`--- Game ${i + 1}: ${entry.label} [${status}] ---`);
    console.log(`  PM mid:     ${fmtProb(snap.pmMid)}`);
    console.log(`  Kalshi mid: ${fmtProb(snap.kalshiMid)}`);
    console.log(`  Gap:        ${snap.gap != null ? `${(snap.gap * 100).toFixed(1)}¢` : "—"}`);
    console.log(
      `  EV if buy on PM (fair=Kalshi):     ${fmtPct(snap.evIfBuyOnPm.ev)}  reason=${snap.evIfBuyOnPm.reason}`
    );
    console.log(
      `  EV if buy on Kalshi (fair=PM):    ${fmtPct(snap.evIfBuyOnKalshi.ev)}  reason=${snap.evIfBuyOnKalshi.reason}`
    );
    console.log(
      `  Guard: PM buy → ${snap.evIfBuyOnPm.reason === "ok" ? "SHOW" : "SUPPRESS (" + snap.evIfBuyOnPm.reason + ")"}`
    );
    console.log(
      `  Guard: Kalshi buy → ${snap.evIfBuyOnKalshi.reason === "ok" ? "SHOW" : "SUPPRESS (" + snap.evIfBuyOnKalshi.reason + ")"}`
    );
    console.log();
  });

  const unmatched = getUnmatchedTeamCodes();
  if (unmatched.kalshi.length || unmatched.polymarket.length) {
    console.log("Unmatched team codes (extend lib/teamCodes.ts):");
    if (unmatched.kalshi.length)
      console.log("  Kalshi:", unmatched.kalshi.join(", "));
    if (unmatched.polymarket.length)
      console.log("  PM:", unmatched.polymarket.join(", "));
  }

  const preOk = picks.filter(
    (e) => snapshotGameEv(e, nowSec).evIfBuyOnPm.reason === "ok"
  ).length;
  const inPlaySuppressed = picks.filter((e) => {
    const s = snapshotGameEv(e, nowSec);
    return s.potentiallyInPlay && !s.preKickoff && s.evIfBuyOnPm.reason === "in_play";
  }).length;

  console.log("=== SUMMARY ===");
  console.log(`Showcase games: ${picks.length}`);
  console.log(`Pre-kickoff with EV shown: ${preOk}`);
  console.log(`In-play zone correctly suppressed: ${inPlaySuppressed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
