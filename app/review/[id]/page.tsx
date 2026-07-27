import { notFound } from "next/navigation";
import { getTradeEvLookupRedisOnly } from "@/lib/evPipeline/redisCache";
import { findQueueById } from "@/lib/x-agent/reviewDb";
import {
  ANONYMOUS_WHALE_PSEUDONYM,
  findWhaleByWallet,
  formatWalletPseudonym,
  isAnonymousWalletAddress,
} from "@/lib/x-agent/whaleRegistryDb";
import ReviewEditor, {
  formatEvLabel,
  formatStakeUsd,
  humanizeMarketSlug,
} from "./ReviewEditor";

export const dynamic = "force-dynamic";

interface ReviewPageProps {
  params: Promise<{ id: string }>;
}

export default async function ReviewPage({ params }: ReviewPageProps) {
  const { id } = await params;
  const item = await findQueueById(id);

  if (!item) {
    notFound();
  }

  const whale = await findWhaleByWallet(item.walletAddress);
  const whaleName = isAnonymousWalletAddress(item.walletAddress)
    ? ANONYMOUS_WHALE_PSEUDONYM
    : whale?.pseudonym ?? formatWalletPseudonym(item.walletAddress);

  let evPercent: number | null = null;
  try {
    const evLookup = await getTradeEvLookupRedisOnly(item.tradeId);
    evPercent = evLookup?.netEvPercent ?? null;
  } catch {
    evPercent = null;
  }

  return (
    <ReviewEditor
      queueId={item.id}
      marketName={humanizeMarketSlug(item.marketSlug)}
      stakeLabel={formatStakeUsd(item.stakeNotional)}
      evLabel={formatEvLabel(evPercent)}
      whaleName={whaleName}
      generatedPostText={item.copyText}
      status={item.status}
    />
  );
}
