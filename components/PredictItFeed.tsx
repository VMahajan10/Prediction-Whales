import type { Market } from "@/lib/polymarket";
import PredictItCard from "@/components/PredictItCard";

interface PredictItFeedProps {
  markets: Market[];
  explorerMode?: boolean;
}

export default function PredictItFeed({
  markets,
  explorerMode = false,
}: PredictItFeedProps) {
  if (markets.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-pulse-muted">
        No PredictIt markets available
      </p>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {markets.map((market) => (
        <PredictItCard
          key={market.id}
          market={market}
          explorerMode={explorerMode}
        />
      ))}
    </div>
  );
}
