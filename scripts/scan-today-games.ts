import {
  buildCrossMarketBookIndex,
  snapshotGameEv,
  gameMatchId,
} from "../lib/crossMarketEv";

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);
  const index = await buildCrossMarketBookIndex();
  const today = new Date(nowSec * 1000).toISOString().slice(0, 10);
  const todayGames = new Map<string, ReturnType<typeof snapshotGameEv>[]>();

  for (const e of index.values()) {
    if (e.game.date !== today) continue;
    const gid = gameMatchId(e.game);
    const list = todayGames.get(gid) ?? [];
    list.push(snapshotGameEv(e, nowSec));
    todayGames.set(gid, list);
  }

  console.log(`Today (${today}) matched games: ${todayGames.size}\n`);
  for (const [gid, snaps] of todayGames) {
    const s = snaps.find((x) => x.outcome === "team_a") ?? snaps[0];
    console.log(gid);
    console.log(
      `  pre=${s.preKickoff} inPlay=${s.potentiallyInPlay} pm=${s.pmMid} k=${s.kalshiMid} gap=${s.gap} reason=${s.evIfBuyOnPm.reason}`
    );
    console.log(
      `  kickoff=${s.game.kickoffEpochSec ? new Date(s.game.kickoffEpochSec * 1000).toISOString() : "?"}`
    );
  }
}

main().catch(console.error);
