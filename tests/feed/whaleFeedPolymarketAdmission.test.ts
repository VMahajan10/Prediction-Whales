import { describe, expect, it } from "vitest";
import { recentTradeToWhale } from "@/lib/feed/whaleFeedHydration";
import type { FeedTrade } from "@/lib/feedTradeTypes";
import {
  admitPolymarketWhalesToBuffer,
  buildQualifiedPolymarketWhales,
  filterVisibleWhales,
  pruneWhaleBufferForVisibility,
  stampWhaleForFeedAdmission,
  whaleKeyForTrade,
} from "@/lib/whaleFeed/polymarketBufferAdmission";
import { resolvePolymarketWalletQualificationState } from "@/lib/whaleFeedClientQualification";
import type { WalletQualification } from "@/lib/useQualifiedWalletFilter";
import type { WhaleTrade } from "@/lib/whaleTrades";

const WALLET = "0xabc123def4567890abcdef1234567890abcdef12";
const TX_HASH = "0xfeedseed1234567890abcdef1234567890abcdef1234567890abcdef123456";

function qualifiedWalletQualification(
  overrides: Partial<WalletQualification> = {}
): WalletQualification {
  return {
    qualified: true,
    avgEv: 0.03,
    resolvedBetsCount: 10,
    avgStakeNotional: 30,
    resolvedVolumeUSD: 300,
    identity: {
      pseudonym: "Qualified Whale",
      initials: "QW",
      winRate: 0.55,
      resolvedBetsCount: 10,
      avgEv: 0.03,
      roi: null,
    },
    ...overrides,
  };
}

function recentPolymarketSeed(): FeedTrade {
  return {
    id: "pm-recent-1",
    source: "polymarket",
    title: "Will Bitcoin reach $100k by end of year?",
    outcome: "Yes",
    side: "BUY",
    price: 0.5,
    size: 1000,
    stake_notional: 500,
    timestamp: 1_800_000_000,
    transactionHash: TX_HASH,
    proxyWallet: WALLET,
    slug: "btc-100k",
    netEvPercent: 4.2,
  };
}

function runPolymarketFeedFunnel(
  seeded: WhaleTrade[],
  walletQualifications: ReadonlyMap<string, WalletQualification>,
  seenKeys = new Set<string>()
) {
  const pipelineEvIndex = new Map();
  const polymarketWhales = seeded.filter((trade) => trade.source === "polymarket");
  const qualified = buildQualifiedPolymarketWhales(
    polymarketWhales,
    walletQualifications,
    pipelineEvIndex
  );
  const admitted = admitPolymarketWhalesToBuffer(
    qualified,
    seenKeys,
    pipelineEvIndex
  );
  const buffer = [...admitted];
  const afterPrune = pruneWhaleBufferForVisibility(
    buffer,
    seenKeys,
    walletQualifications,
    pipelineEvIndex
  );
  const finalWhales = filterVisibleWhales(
    afterPrune,
    walletQualifications,
    pipelineEvIndex
  );

  return {
    polymarketWhales,
    qualified,
    admitted,
    afterPrune,
    finalWhales,
    seenKeys,
  };
}

describe("whaleFeed Polymarket admission funnel", () => {
  it("hydrates recent seed → qualifies → admits → survives prune → renders", () => {
    const hydrated = recentTradeToWhale(recentPolymarketSeed());
    expect(hydrated).not.toBeNull();

    const quals = new Map([[WALLET, qualifiedWalletQualification()]]);
    const funnel = runPolymarketFeedFunnel([hydrated!], quals);

    expect(funnel.polymarketWhales).toHaveLength(1);
    expect(funnel.qualified).toHaveLength(1);
    expect(funnel.admitted).toHaveLength(1);
    expect(funnel.afterPrune).toHaveLength(1);
    expect(funnel.finalWhales).toHaveLength(1);
    expect(funnel.finalWhales[0]?.transactionHash).toBe(TX_HASH);
  });

  it("keeps pending qualification hidden without permanently discarding the trade", () => {
    const hydrated = recentTradeToWhale(recentPolymarketSeed());
    expect(hydrated).not.toBeNull();

    const seenKeys = new Set<string>();
    const pending = runPolymarketFeedFunnel([hydrated!], new Map(), seenKeys);

    expect(
      resolvePolymarketWalletQualificationState(WALLET, new Map())
    ).toBe("pending");
    expect(pending.qualified).toHaveLength(0);
    expect(pending.admitted).toHaveLength(0);
    expect(pending.finalWhales).toHaveLength(0);
    expect(seenKeys.size).toBe(0);

    const quals = new Map([[WALLET, qualifiedWalletQualification()]]);
    const resolved = runPolymarketFeedFunnel([hydrated!], quals, seenKeys);

    expect(resolved.qualified).toHaveLength(1);
    expect(resolved.admitted).toHaveLength(1);
    expect(resolved.finalWhales).toHaveLength(1);
  });

  it("never renders when wallet qualification resolves FAIL", () => {
    const hydrated = recentTradeToWhale(recentPolymarketSeed());
    expect(hydrated).not.toBeNull();

    const quals = new Map([
      [WALLET, qualifiedWalletQualification({ avgEv: 0.01, qualified: false })],
    ]);
    const funnel = runPolymarketFeedFunnel([hydrated!], quals);

    expect(
      resolvePolymarketWalletQualificationState(WALLET, quals)
    ).toBe("fail");
    expect(funnel.qualified).toHaveLength(0);
    expect(funnel.admitted).toHaveLength(0);
    expect(funnel.finalWhales).toHaveLength(0);
  });

  it("releases seen-keys when pruned so trades can re-enter after qualification resolves", () => {
    const hydrated = recentTradeToWhale(recentPolymarketSeed());
    expect(hydrated).not.toBeNull();

    const pipelineEvIndex = new Map();
    const admitted = stampWhaleForFeedAdmission(hydrated!, pipelineEvIndex);
    expect(admitted).not.toBeNull();

    const seenKeys = new Set([whaleKeyForTrade(admitted!)]);
    const pruned = pruneWhaleBufferForVisibility(
      [admitted!],
      seenKeys,
      new Map(),
      pipelineEvIndex
    );

    expect(pruned).toHaveLength(0);
    expect(seenKeys.size).toBe(0);

    const quals = new Map([[WALLET, qualifiedWalletQualification()]]);
    const reAdmitted = admitPolymarketWhalesToBuffer(
      buildQualifiedPolymarketWhales([hydrated!], quals, pipelineEvIndex),
      seenKeys,
      pipelineEvIndex
    );

    expect(reAdmitted).toHaveLength(1);
    expect(
      filterVisibleWhales(reAdmitted, quals, pipelineEvIndex)
    ).toHaveLength(1);
  });

  it("identifies qualifiedPolymarketWhales as the first funnel stage that drops pending seeds", () => {
    const hydrated = recentTradeToWhale(recentPolymarketSeed());
    expect(hydrated).not.toBeNull();

    const pipelineEvIndex = new Map();
    const polymarketWhales = [hydrated!];
    const qualified = buildQualifiedPolymarketWhales(
      polymarketWhales,
      new Map(),
      pipelineEvIndex
    );

    expect(polymarketWhales).toHaveLength(1);
    expect(qualified).toHaveLength(0);
  });

  it("renders Darline production-shaped recent seed after wallet qualification PASS", () => {
    const darlineWallet = "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296";
    const darlineTx =
      "0x59c3aad53bf226ee382efb4b33bbaa4b43563d4298450011e06c9837e891232a";

    const hydrated = recentTradeToWhale({
      id: darlineTx,
      source: "polymarket",
      title:
        "Will Darline Graham Nordone be the new republican nominee for Senate in South Carolina?",
      outcome: "Yes",
      side: "BUY",
      price: 0.663,
      size: 1000,
      stake_notional: 663,
      timestamp: 1_787_599_598,
      transactionHash: darlineTx,
      slug: "will-person-f-be-the-new-republican-nominee-for-senate-in-south-carolina-20260712140628838",
      proxyWallet: darlineWallet,
      netEvPercent: 21,
    });

    expect(hydrated).not.toBeNull();

    const quals = new Map([
      [
        darlineWallet,
        qualifiedWalletQualification({
          avgEv: 2.615449247885752,
          resolvedBetsCount: 50,
          avgStakeNotional: 1341.6,
          resolvedVolumeUSD: 67079.99,
        }),
      ],
    ]);

    const funnel = runPolymarketFeedFunnel([hydrated!], quals);
    expect(funnel.finalWhales).toHaveLength(1);
    expect(funnel.finalWhales[0]?.transactionHash).toBe(darlineTx);
    expect(
      resolvePolymarketWalletQualificationState(darlineWallet, quals)
    ).toBe("pass");
  });
});
