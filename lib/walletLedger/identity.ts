import { normalizeWalletAddress } from "@/lib/walletLedger/walletAddress";
import { resolveWalletForTrade } from "@/lib/resolveWhaleWallet";
import {
  IDENTITY_AMBIGUITY_RATIO,
  MEANINGFUL_HISTORY_ROW_THRESHOLD,
} from "@/lib/walletLedger/constants";
import { fetchPositionsSnapshot, probeWalletHistoryCounts } from "@/lib/walletLedger/fetchers";
import type {
  HistoryIdentityCandidate,
  HistoryResolutionMethod,
  IdentityConfidence,
  IdentityResolutionEvidence,
  PolymarketHistoryIdentity,
} from "@/lib/walletLedger/types";

export interface ResolvePolymarketHistoryIdentityInput {
  wallet: string;
  transactionHash?: string;
  assetId?: string;
  /** Skip network probes (for unit tests). */
  probe?: (
    wallet: string
  ) => Promise<{
    activityCount: number;
    tradeCount: number;
    positionsCount: number;
    activityTruncated?: boolean;
    tradeTruncated?: boolean;
  }>;
}

function historyScore(counts: {
  activityCount: number;
  tradeCount: number;
  positionsCount: number;
}): number {
  return counts.activityCount + counts.tradeCount;
}

function buildCandidate(
  wallet: string,
  source: HistoryIdentityCandidate["source"],
  counts: {
    activityCount: number;
    tradeCount: number;
    positionsCount: number;
  }
): HistoryIdentityCandidate {
  return {
    wallet,
    source,
    ...counts,
    historyScore: historyScore(counts),
  };
}

function pickConfidence(
  method: HistoryResolutionMethod,
  winner: HistoryIdentityCandidate,
  requested: HistoryIdentityCandidate,
  positionsOnlyMismatch: boolean
): IdentityConfidence {
  if (method === "ambiguous" || method === "unresolved") return "low";
  if (positionsOnlyMismatch) return "low";
  if (method === "proxy_wallet_direct" && winner.wallet === requested.wallet) {
    if (winner.historyScore >= MEANINGFUL_HISTORY_ROW_THRESHOLD) return "high";
    if (winner.positionsCount > 0 && winner.historyScore === 0) return "low";
    return "medium";
  }
  if (
    method === "onchain_receipt_resolved" ||
    method === "data_api_resolved"
  ) {
    return winner.historyScore >= MEANINGFUL_HISTORY_ROW_THRESHOLD
      ? "high"
      : "medium";
  }
  return "medium";
}

export function rankHistoryIdentityCandidates(
  candidates: HistoryIdentityCandidate[],
  options?: { transactionHashResolved?: boolean }
): {
  resolutionMethod: HistoryResolutionMethod;
  historyWallet: string | null;
  winner: HistoryIdentityCandidate | null;
  positionsOnlyMismatch: boolean;
} {
  const sorted = [...candidates].sort((a, b) => b.historyScore - a.historyScore);
  if (sorted.length === 0) {
    return {
      resolutionMethod: "unresolved",
      historyWallet: null,
      winner: null,
      positionsOnlyMismatch: false,
    };
  }

  const winner = sorted[0];
  const runnerUp = sorted[1];

  const bothMeaningful =
    winner.historyScore >= MEANINGFUL_HISTORY_ROW_THRESHOLD &&
    runnerUp &&
    runnerUp.historyScore >= MEANINGFUL_HISTORY_ROW_THRESHOLD;

  const ambiguous =
    bothMeaningful &&
    runnerUp.historyScore / winner.historyScore >= IDENTITY_AMBIGUITY_RATIO;

  if (ambiguous) {
    return {
      resolutionMethod: "ambiguous",
      historyWallet: null,
      winner: null,
      positionsOnlyMismatch: false,
    };
  }

  if (winner.historyScore > 0) {
    let resolutionMethod: HistoryResolutionMethod = "proxy_wallet_direct";
    if (winner.source === "onchain") resolutionMethod = "onchain_receipt_resolved";
    else if (winner.source === "data_api" || winner.source === "positions_proxy") {
      resolutionMethod = "data_api_resolved";
    }
    return {
      resolutionMethod,
      historyWallet: winner.wallet,
      winner,
      positionsOnlyMismatch: false,
    };
  }

  if (winner.positionsCount > 0 && winner.historyScore === 0) {
    if (options?.transactionHashResolved && runnerUp && runnerUp.historyScore > 0) {
      let resolutionMethod: HistoryResolutionMethod = "onchain_receipt_resolved";
      if (runnerUp.source === "data_api" || runnerUp.source === "positions_proxy") {
        resolutionMethod = "data_api_resolved";
      }
      return {
        resolutionMethod,
        historyWallet: runnerUp.wallet,
        winner: runnerUp,
        positionsOnlyMismatch: true,
      };
    }

    return {
      resolutionMethod: "unresolved",
      historyWallet: null,
      winner,
      positionsOnlyMismatch: true,
    };
  }

  return {
    resolutionMethod: "unresolved",
    historyWallet: null,
    winner,
    positionsOnlyMismatch: false,
  };
}

function emptyIdentity(requestedWallet: string): PolymarketHistoryIdentity {
  return {
    requestedWallet,
    historyWallet: null,
    resolutionMethod: "unresolved",
    confidence: "low",
    candidateWallets: [],
    alternateCandidates: [],
    evidence: { notes: [] },
    positionsOnlyMismatch: false,
    activityCount: 0,
    tradeCount: 0,
    positionsCount: 0,
  };
}

/**
 * Resolve which address should be used for Polymarket wallet history fetches.
 * Probes Data API endpoints and refuses to guess when multiple addresses qualify.
 */
export async function resolvePolymarketHistoryIdentity(
  input: ResolvePolymarketHistoryIdentityInput
): Promise<PolymarketHistoryIdentity> {
  const requestedWallet = normalizeWalletAddress(input.wallet);
  if (!requestedWallet) {
    return emptyIdentity(input.wallet);
  }

  const probe = input.probe ?? probeWalletHistoryCounts;
  const candidateMap = new Map<string, HistoryIdentityCandidate>();
  const evidence: IdentityResolutionEvidence = { notes: [] };

  const remember = async (
    wallet: string,
    source: HistoryIdentityCandidate["source"]
  ) => {
    const normalized = normalizeWalletAddress(wallet);
    if (!normalized || candidateMap.has(normalized)) return;
    const counts = await probe(normalized);
    candidateMap.set(
      normalized,
      buildCandidate(normalized, source, counts)
    );
  };

  await remember(requestedWallet, "requested");

  let transactionHashResolved = false;
  if (input.transactionHash) {
    evidence.transactionHash = input.transactionHash;
    evidence.assetId = input.assetId;
    const resolved = await resolveWalletForTrade(input.transactionHash, {
      assetId: input.assetId,
    });
    if (resolved.wallet) {
      transactionHashResolved = true;
      evidence.resolvedFromTxWallet = resolved.wallet;
      evidence.txResolutionSource = resolved.source ?? undefined;
      evidence.notes.push(
        `transaction_hash_resolved:${resolved.wallet}:${resolved.source ?? "unknown"}`
      );
      const source =
        resolved.source === "onchain-economic"
          ? "onchain"
          : resolved.source?.startsWith("data-api")
            ? "data_api"
            : undefined;
      if (source) {
        await remember(resolved.wallet, source);
      }
    } else {
      evidence.notes.push("transaction_hash_resolution_failed");
    }
  }

  const positions = await fetchPositionsSnapshot(requestedWallet);
  const proxyWallets = new Set<string>();
  for (const row of positions) {
    const proxy = row.proxyWallet?.trim().toLowerCase();
    if (proxy && proxy !== requestedWallet) proxyWallets.add(proxy);
  }
  for (const proxy of proxyWallets) {
    await remember(proxy, "positions_proxy");
  }

  const candidates = [...candidateMap.values()].sort(
    (a, b) => b.historyScore - a.historyScore
  );

  if (candidates.length === 0) {
    return emptyIdentity(requestedWallet);
  }

  const requestedCandidate =
    candidates.find((c) => c.wallet === requestedWallet) ?? candidates[0];

  const ranked = rankHistoryIdentityCandidates(candidates, {
    transactionHashResolved,
  });
  const resolutionMethod = ranked.resolutionMethod;
  const historyWallet = ranked.historyWallet;

  const selected = historyWallet
    ? candidates.find((c) => c.wallet === historyWallet) ?? ranked.winner!
    : requestedCandidate;

  const confidence = pickConfidence(
    resolutionMethod,
    selected,
    requestedCandidate,
    ranked.positionsOnlyMismatch
  );

  if (ranked.positionsOnlyMismatch && !input.transactionHash) {
    evidence.notes.push("positions_without_history_events_no_tx_hash");
  }

  const alternateCandidates = candidates
    .map((c) => c.wallet)
    .filter((w) => w !== historyWallet);

  return {
    requestedWallet,
    historyWallet,
    resolutionMethod,
    confidence,
    candidateWallets: candidates,
    alternateCandidates,
    evidence,
    positionsOnlyMismatch: ranked.positionsOnlyMismatch,
    activityCount: historyWallet ? selected.activityCount : requestedCandidate.activityCount,
    tradeCount: historyWallet ? selected.tradeCount : requestedCandidate.tradeCount,
    positionsCount: requestedCandidate.positionsCount,
  };
}
