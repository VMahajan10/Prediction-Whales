import {
  AI_INSIGHT_DISCLAIMER_TEXT,
  FEED_DISCLAIMER_TEXT,
} from "@/lib/legalCompliance";

type FeedLegalDisclaimerProps = {
  variant?: "feed" | "ai" | "both";
  className?: string;
};

export default function FeedLegalDisclaimer({
  variant = "feed",
  className = "",
}: FeedLegalDisclaimerProps) {
  const lines =
    variant === "both"
      ? [FEED_DISCLAIMER_TEXT, AI_INSIGHT_DISCLAIMER_TEXT]
      : variant === "ai"
        ? [AI_INSIGHT_DISCLAIMER_TEXT]
        : [FEED_DISCLAIMER_TEXT];

  return (
    <p
      className={`text-[10px] leading-relaxed text-pulse-label ${className}`}
      role="note"
    >
      {lines.join(" ")}
    </p>
  );
}
