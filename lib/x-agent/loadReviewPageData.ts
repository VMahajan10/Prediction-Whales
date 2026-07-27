import { getTradeEvLookupRedisOnly } from "@/lib/evPipeline/redisCache";
import { isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { findQueueById } from "@/lib/x-agent/reviewDb";
import {
  ANONYMOUS_WHALE_PSEUDONYM,
  findWhaleByWallet,
  formatWalletPseudonym,
  isAnonymousWalletAddress,
} from "@/lib/x-agent/whaleRegistryDb";
import { logReviewRouteEnvStatus } from "@/lib/serverEnv";
import {
  formatReviewEvLabel,
  formatReviewStakeUsd,
  humanizeMarketSlug,
} from "@/lib/reviewDisplay";

export interface ReviewPageEditorProps {
  queueId: string;
  marketName: string;
  stakeLabel: string;
  evLabel: string;
  whaleName: string;
  generatedPostText: string;
  status: string;
}

export type ReviewPageLoadResult =
  | { kind: "ok"; props: ReviewPageEditorProps }
  | { kind: "not_found" }
  | { kind: "unavailable"; title: string; message: string };

export async function loadReviewPageData(
  queueId: string
): Promise<ReviewPageLoadResult> {
  logReviewRouteEnvStatus();

  const trimmedId = queueId.trim();
  if (!trimmedId) {
    return { kind: "not_found" };
  }

  if (!isDatabaseEnabled()) {
    console.error(
      "[review/[id]] DATABASE_URL is missing — cannot load x_post_queue row"
    );
    return {
      kind: "unavailable",
      title: "Review unavailable",
      message:
        "Database is not configured on this server. Set DATABASE_URL to enable post review.",
    };
  }

  try {
    const item = await findQueueById(trimmedId);
    if (!item) {
      return { kind: "not_found" };
    }

    let whaleName = ANONYMOUS_WHALE_PSEUDONYM;
    try {
      if (isAnonymousWalletAddress(item.walletAddress)) {
        whaleName = ANONYMOUS_WHALE_PSEUDONYM;
      } else {
        const whale = await findWhaleByWallet(item.walletAddress);
        whaleName =
          whale?.pseudonym ?? formatWalletPseudonym(item.walletAddress);
      }
    } catch (whaleError) {
      console.warn(
        "[review/[id]] Whale registry lookup failed:",
        whaleError instanceof Error ? whaleError.message : whaleError
      );
      whaleName = formatWalletPseudonym(item.walletAddress);
    }

    let evPercent: number | null = null;
    try {
      const evLookup = await getTradeEvLookupRedisOnly(item.tradeId);
      evPercent = evLookup?.netEvPercent ?? null;
    } catch (evError) {
      console.warn(
        "[review/[id]] Trade EV lookup failed:",
        evError instanceof Error ? evError.message : evError
      );
    }

    return {
      kind: "ok",
      props: {
        queueId: item.id,
        marketName: humanizeMarketSlug(item.marketSlug),
        stakeLabel: formatReviewStakeUsd(item.stakeNotional),
        evLabel: formatReviewEvLabel(evPercent),
        whaleName,
        generatedPostText: item.copyText,
        status: item.status,
      },
    };
  } catch (error) {
    console.error("[review/[id]] Failed to load queue item:", error);
    return {
      kind: "unavailable",
      title: "Could not load review",
      message:
        "The database query failed. Try again in a moment or check server logs.",
    };
  }
}
