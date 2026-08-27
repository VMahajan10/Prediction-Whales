import { resolveWalletForTrade } from "@/lib/resolveWhaleWallet";
import {
  decodeLog,
  orderFilledInvolvesWallet,
} from "@/lib/walletLedger/onchain/decode";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import type { OnChainWalletIdentityReport } from "@/lib/walletLedger/onchain/types";
import { fetchPositionsSnapshot } from "@/lib/walletLedger/fetchers";
import { normalizeWalletAddress } from "@/lib/walletLedger/walletAddress";

export interface DiscoverWalletIdentityInput {
  wallet: string;
  transactionHash?: string;
  assetId?: string;
  rpc?: PolygonRpcClient;
}

const SYSTEM_PREFIXES = [
  "0xe2222d279d744050d28e00520010520000310f59",
  "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
  "0xe111180000d2663c0091e4f400237545b87b996b",
  "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
];

function isUserAddress(address: string): boolean {
  return !SYSTEM_PREFIXES.includes(address.toLowerCase());
}

export async function discoverOnChainWalletIdentity(
  input: DiscoverWalletIdentityInput
): Promise<OnChainWalletIdentityReport> {
  const requestedWallet =
    normalizeWalletAddress(input.wallet) ?? input.wallet.toLowerCase();
  const rpc = input.rpc ?? new PolygonRpcClient();
  const related = new Map<string, { role: string; evidence: string }>();

  const remember = (address: string, role: string, evidence: string) => {
    const normalized = normalizeWalletAddress(address);
    if (!normalized || !isUserAddress(normalized)) return;
    const existing = related.get(normalized);
    if (!existing) {
      related.set(normalized, { role, evidence });
      return;
    }
    related.set(normalized, {
      role: `${existing.role},${role}`,
      evidence: `${existing.evidence}; ${evidence}`,
    });
  };

  remember(requestedWallet, "requested", "audit_input");

  const positions = await fetchPositionsSnapshot(requestedWallet);
  for (const row of positions) {
    const proxy = row.proxyWallet?.trim().toLowerCase();
    if (proxy) remember(proxy, "positions_proxy", "positions_snapshot");
  }

  let requestedInTrade = false;

  if (input.transactionHash) {
    const resolved = await resolveWalletForTrade(input.transactionHash, {
      assetId: input.assetId,
    });
    if (resolved.wallet) {
      remember(
        resolved.wallet,
        "tx_hash_resolved",
        `resolveWalletForTrade:${resolved.source}`
      );
    }

    const receipt = await rpc.getTransactionReceipt(input.transactionHash);
    for (const log of receipt?.logs ?? []) {
      const parsed = decodeLog(log);
      if (parsed.type === "order_filled") {
        const fill = parsed.event;
        remember(fill.maker, "order_filled_maker", input.transactionHash);
        remember(fill.taker, "order_filled_taker", input.transactionHash);
        if (orderFilledInvolvesWallet(fill, requestedWallet)) {
          requestedInTrade = true;
          remember(
            requestedWallet,
            "order_filled_participant",
            input.transactionHash
          );
        }
      }
      if (parsed.type === "erc1155_transfer") {
        const t = parsed.event;
        remember(t.from, "ctf_transfer_from", input.transactionHash);
        remember(t.to, "ctf_transfer_to", input.transactionHash);
        if (t.from === requestedWallet || t.to === requestedWallet) {
          requestedInTrade = true;
        }
      }
    }
  }

  const relatedAddresses = [...related.keys()].filter(
    (addr) => addr !== requestedWallet
  );

  let canonicalHistorySubjects: string[] = [];
  let confidence: OnChainWalletIdentityReport["confidence"] = "low";

  if (requestedInTrade) {
    canonicalHistorySubjects = [requestedWallet];
    confidence = "high";
  } else if (positions.length > 0 && relatedAddresses.length > 0) {
    const tradeParticipants = relatedAddresses.filter((addr) => {
      const entry = related.get(addr);
      return entry?.role.includes("order_filled");
    });
    canonicalHistorySubjects = tradeParticipants.slice(0, 2);
    confidence = tradeParticipants.length === 1 ? "medium" : "low";
  } else if (relatedAddresses.length === 1) {
    canonicalHistorySubjects = [relatedAddresses[0]];
    confidence = "medium";
  } else {
    canonicalHistorySubjects = [requestedWallet];
    confidence = "low";
  }

  return {
    requestedWallet,
    relatedAddresses,
    relationshipEvidence: [...related.entries()].map(([address, value]) => ({
      address,
      role: value.role,
      evidence: value.evidence,
    })),
    canonicalHistorySubjects,
    confidence,
  };
}
