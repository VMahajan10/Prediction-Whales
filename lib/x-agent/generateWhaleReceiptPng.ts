import { ImageResponse } from "@vercel/og";
import React from "react";
import type { XPostQueue } from "@/lib/crossmarket/store/schema";
import { humanizeMarketSlug } from "@/lib/reviewDisplay";
import { formatWhaleDisplayLabel } from "@/lib/x-agent/whaleDisplay";
import { findWhaleByWallet } from "@/lib/x-agent/whaleRegistryDb";
import { WhaleReceiptCard } from "@/lib/x-agent/whaleReceiptCard";
import type { WhaleReceiptData } from "@/lib/x-agent/whaleReceiptTypes";

export type { WhaleReceiptData } from "@/lib/x-agent/whaleReceiptTypes";

const RECEIPT_WIDTH = 1200;
const RECEIPT_HEIGHT = 675;

let interBoldCache: ArrayBuffer | null = null;
let interSemiBoldCache: ArrayBuffer | null = null;

async function loadFont(url: string, cache: "bold" | "semibold"): Promise<ArrayBuffer> {
  if (cache === "bold" && interBoldCache) return interBoldCache;
  if (cache === "semibold" && interSemiBoldCache) return interSemiBoldCache;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load receipt font (${response.status})`);
  }

  const buffer = await response.arrayBuffer();
  if (cache === "bold") {
    interBoldCache = buffer;
  } else {
    interSemiBoldCache = buffer;
  }
  return buffer;
}

export function formatUsdStake(stakeNotional: number): string {
  return `$${Math.round(stakeNotional).toLocaleString("en-US")}`;
}

export function formatCentsLabel(cents: number): string {
  return `${Math.round(cents)}¢`;
}

/** Registry stores win rate as decimal (0.68 = 68%). */
export function formatWinRatePercent(winRateDecimal: number): string {
  if (!Number.isFinite(winRateDecimal)) return "—";
  return `${Math.round(winRateDecimal * 100)}%`;
}

/** Registry stores avg EV as decimal (0.12 = +12%). */
export function formatAvgEvPercent(avgEvDecimal: number): string {
  if (!Number.isFinite(avgEvDecimal)) return "—";
  const pct = avgEvDecimal * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function buildWhaleReceiptData(
  item: Pick<
    XPostQueue,
    | "marketSlug"
    | "side"
    | "stakeNotional"
    | "entryCents"
    | "nowCents"
    | "walletAddress"
  >,
  whale: {
    pseudonym?: string | null;
    winRate?: number | null;
    avgEv?: number | null;
  } | null,
  whaleBadge?: string
): WhaleReceiptData {
  const avgEvDecimal = whale?.avgEv ?? 0;
  const avgEvLabel = formatAvgEvPercent(avgEvDecimal);

  return {
    marketTitle: humanizeMarketSlug(item.marketSlug),
    outcomeSide: item.side,
    stakeLabel: formatUsdStake(item.stakeNotional),
    entryLabel: formatCentsLabel(item.entryCents),
    nowLabel: formatCentsLabel(item.nowCents),
    winRateLabel: formatWinRatePercent(whale?.winRate ?? 0),
    avgEvLabel,
    avgEvPercent: avgEvLabel,
    whaleBadge:
      whaleBadge ??
      formatWhaleDisplayLabel(item.walletAddress, whale?.pseudonym ?? null),
  };
}

export async function resolveWhaleReceiptData(
  item: XPostQueue
): Promise<WhaleReceiptData> {
  const whale = await findWhaleByWallet(item.walletAddress);
  return buildWhaleReceiptData(item, whale);
}

/** Render a PNG trade receipt for X media attachment. */
export async function generateWhaleReceiptPng(
  data: WhaleReceiptData
): Promise<Buffer> {
  const [interBold, interSemiBold] = await Promise.all([
    loadFont(
      "https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.18/files/inter-latin-700-normal.woff",
      "bold"
    ),
    loadFont(
      "https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.18/files/inter-latin-600-normal.woff",
      "semibold"
    ),
  ]);

  const image = new ImageResponse(
    React.createElement(WhaleReceiptCard, { data }),
    {
      width: RECEIPT_WIDTH,
      height: RECEIPT_HEIGHT,
      fonts: [
        {
          name: "Inter",
          data: interBold,
          weight: 700,
          style: "normal",
        },
        {
          name: "Inter",
          data: interSemiBold,
          weight: 600,
          style: "normal",
        },
      ],
    }
  );

  const arrayBuffer = await image.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
