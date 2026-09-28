import { beforeEach, describe, expect, it, vi } from "vitest";
import type { XPostQueue } from "@/lib/crossmarket/store/schema";

const createMock = vi.fn().mockResolvedValue({ id: "q-new" });
const findFirstMock = vi.fn().mockResolvedValue(null);

vi.mock("@/lib/prisma", () => ({
  isPrismaEnabled: () => true,
  getPrisma: () => ({
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    xPostQueue: {
      findFirst: findFirstMock,
      create: createMock,
    },
  }),
}));

vi.mock("@/lib/x-agent/ensureXPostQueueSchema", () => ({
  ensureXPostQueueSchemaOnce: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/x-agent/marketResolution", () => ({
  isMarketResolvedYesForSide: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/x-agent/whaleRegistryDb", () => ({
  findWhaleByWallet: vi.fn().mockResolvedValue({
    walletAddress: "0xabc1234567890abcdef1234567890abcdef12",
    pseudonym: "CrimsonVanguard",
    avgEv: 0.1,
    winRate: 0.6,
    resolvedBetsCount: 500,
    avgStakeNotional: 10_000,
    postedCount30d: 2,
  }),
}));

vi.mock("@/lib/templates/queueHelpers", () => ({
  fetchLastTemplateFamily: vi.fn().mockResolvedValue("V1"),
  fetchLastVariantId: vi.fn().mockResolvedValue(null),
  fetchLastSentenceOrderIndex: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/x-agent/evGlossStore", () => ({
  fetchLastEvGloss: vi.fn().mockResolvedValue(null),
  persistLastEvGloss: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/x-agent/getWhaleAlias", () => ({
  getWhaleAlias: vi.fn().mockResolvedValue("CrimsonVanguard"),
}));

import { enqueueResolutionReceiptForPublishedPost } from "@/lib/x-agent/resolutionReceiptPipeline";

function publishedFixture(): XPostQueue {
  return {
    id: "pub-1",
    walletAddress: "0xabc1234567890abcdef1234567890abcdef12",
    tradeId: "trade-1",
    templateFamily: "V1",
    variantId: "V1-a",
    evGloss: "profitable on average",
    copyText: "draft",
    marketSlug: "test-market",
    side: "Zhizhen Zhang",
    entryCents: 64,
    nowCents: 70,
    stakeNotional: 50_000,
    status: "PUBLISHED",
    reviewToken: "token",
    scheduledFor: null,
    xTweetId: "tweet",
    xMediaId: null,
    receiptMediaUrl: null,
    publicTelegramMessageId: null,
    decidedBy: null,
    decidedAt: null,
    dispatchedAt: new Date(),
    publishRetryCount: 0,
    lastPublishError: null,
    sentenceOrderIndex: 0,
    receiptForQueueId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("enqueueResolutionReceiptForPublishedPost", () => {
  beforeEach(() => {
    createMock.mockClear();
    findFirstMock.mockResolvedValue(null);
  });

  it("enqueues V8 PENDING_REVIEW linked to the published source row", async () => {
    const result = await enqueueResolutionReceiptForPublishedPost(
      publishedFixture()
    );
    expect(result.ok).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(1);
    const data = createMock.mock.calls[0][0].data;
    expect(data.status).toBe("PENDING_REVIEW");
    expect(data.templateFamily).toBe("V8");
    expect(data.receiptForQueueId).toBe("pub-1");
    expect(data.tradeId).toBe("receipt:pub-1");
  });

  it("skips duplicate receipts for the same published post", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "existing-receipt" });
    const result = await enqueueResolutionReceiptForPublishedPost(
      publishedFixture()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("duplicate_receipt");
    expect(createMock).not.toHaveBeenCalled();
  });
});
