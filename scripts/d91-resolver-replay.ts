#!/usr/bin/env tsx
/**
 * Read-only replay of corrected trader resolver on historical d91 feed rows.
 * Produces re-attribution / unresolved classification — no DB writes.
 */
import "../tests/preload-env";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { feedTrades } from "@/lib/crossmarket/store/schema";
import { clearWalletResolutionCache, resolveWalletForTrade } from "@/lib/resolveWhaleWallet";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import { resolveTraderFromReceiptLogs } from "@/lib/resolveWhaleWalletEconomic";

const D91 = "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296";

function payloadField(payload: unknown, key: string): unknown {
  if (!payload || typeof payload !== "object") return undefined;
  return (payload as Record<string, unknown>)[key];
}

async function main(): Promise<void> {
  clearWalletResolutionCache();
  const db = getDb();
  const rows = await db
    .select()
    .from(feedTrades)
    .where(sql`lower(${feedTrades.proxyWallet}) = ${D91}`);

  const rpc = new PolygonRpcClient();
  const frequency = new Map<string, number>();
  let previouslyD91 = rows.length;
  let correctedResolved = 0;
  let correctedUnresolved = 0;
  let d91StillSelected = 0;
  let apiDisagreements = 0;

  const safelyReAttributable: string[] = [];
  const unresolved: string[] = [];
  const details: unknown[] = [];

  for (const row of rows) {
    const payload = row.payload;
    const assetId = (payloadField(payload, "assetId") as string | undefined)?.trim();
    const side = payloadField(payload, "side") as "BUY" | "SELL" | undefined;
    const size =
      (payloadField(payload, "size") as number | undefined) ??
      (payloadField(payload, "sizeShares") as number | undefined);
    const apiProxy = (
      (payloadField(payload, "proxyWallet") as string | undefined) ??
      row.proxyWallet
    )?.toLowerCase();

    const hash =
      row.transactionHash?.toLowerCase() ??
      (row.tradeId.startsWith("0x") ? row.tradeId.toLowerCase() : null);

    let correctedWallet: string | null = null;
    let source: string | null = null;
    let economicReason = "no_receipt";

    if (hash) {
      const trusted = apiProxy && apiProxy !== D91 ? apiProxy : undefined;
      const resolved = await resolveWalletForTrade(hash, {
        assetId,
        side,
        sizeShares: size,
        trustedApiProxyWallet: trusted,
      });
      correctedWallet = resolved.wallet;
      source = resolved.source;

      const receipt = await rpc.getTransactionReceipt(hash);
      if (receipt?.logs?.length) {
        const economic = resolveTraderFromReceiptLogs(receipt.logs as never, {
          assetId,
          side,
          sizeShares: size,
        });
        economicReason = economic.reason;
      }
    } else {
      unresolved.push(row.tradeId);
      correctedUnresolved += 1;
      continue;
    }

    if (correctedWallet) {
      correctedResolved += 1;
      frequency.set(
        correctedWallet,
        (frequency.get(correctedWallet) ?? 0) + 1
      );
      if (correctedWallet === D91) d91StillSelected += 1;
      else safelyReAttributable.push(row.tradeId);
    } else {
      correctedUnresolved += 1;
      unresolved.push(row.tradeId);
    }

    if (
      apiProxy &&
      correctedWallet &&
      apiProxy !== correctedWallet &&
      apiProxy !== D91
    ) {
      apiDisagreements += 1;
    }

    details.push({
      tradeId: row.tradeId,
      txHash: hash,
      feedProxy: row.proxyWallet,
      payloadApiProxy: apiProxy,
      assetId,
      side,
      size,
      correctedWallet,
      source,
      economicReason,
    });
  }

  const plan = {
    mode: "d91_resolver_replay_readonly",
    previouslyAttributedToD91: previouslyD91,
    correctedUniquelyResolved: correctedResolved,
    correctedUnresolved,
    d91StillSelected,
    apiDisagreementsWithCorrected: apiDisagreements,
    walletFrequency: [...frequency.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([wallet, count]) => ({ wallet, count })),
    backfillPlan: {
      safelyReAttributable: {
        count: safelyReAttributable.length,
        tradeIds: safelyReAttributable,
      },
      unresolved: {
        count: unresolved.length,
        tradeIds: unresolved,
      },
      note:
        "No DB writes performed. Re-attributable rows have a unique economic OrderFilled trader != d91. Unresolved rows should clear trusted d91 proxy per feed schema semantics.",
    },
  };

  const out = join(process.cwd(), "tmp", "d91-resolver-replay.json");
  writeFileSync(out, JSON.stringify({ plan, details }, null, 2));
  console.log(JSON.stringify(plan, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
