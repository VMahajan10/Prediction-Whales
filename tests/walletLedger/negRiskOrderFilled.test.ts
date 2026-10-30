import { describe, expect, it } from "vitest";
import {
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  TOPIC_ORDER_FILLED_NEG_RISK,
} from "@/lib/walletLedger/onchain/contracts";
import { decodeLog } from "@/lib/walletLedger/onchain/decode";
import { orderFilledToLedgerEvents } from "@/lib/walletLedger/onchain/normalize";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";

const PROXY = "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";
const SPAIN_ASSET =
  "4394372887385518214471608448209527405727552777602031099972143344338178308080";

function addressTopic(addr: string): string {
  return `0x${addr.slice(2).padStart(64, "0")}`;
}

function negRiskLog(input: {
  maker: string;
  taker: string;
  makerAssetId: bigint;
  takerAssetId: bigint;
  makerAmount: bigint;
  takerAmount: bigint;
}): RpcLog {
  return {
    address: NEG_RISK_CTF_EXCHANGE_ADDRESS,
    topics: [
      TOPIC_ORDER_FILLED_NEG_RISK,
      `0x${"aa".repeat(32)}`,
      addressTopic(input.maker),
      addressTopic(input.taker),
    ],
    data: `0x${[
      input.makerAssetId.toString(16).padStart(64, "0"),
      input.takerAssetId.toString(16).padStart(64, "0"),
      input.makerAmount.toString(16).padStart(64, "0"),
      input.takerAmount.toString(16).padStart(64, "0"),
    ].join("")}`,
    blockNumber: "0x56a1232",
    transactionHash: "0xspain",
    logIndex: "0x1",
  };
}

describe("neg-risk OrderFilled economics", () => {
  it("maps taker SELL when maker pays USDC (asset 0)", () => {
    const log = negRiskLog({
      maker: "0x97f937e0ec5068121db4a4b900140544b09f4e4f",
      taker: PROXY,
      makerAssetId: 0n,
      takerAssetId: BigInt(SPAIN_ASSET),
      makerAmount: 792_376_830n,
      takerAmount: 793_170_000n,
    });
    const parsed = decodeLog(log);
    expect(parsed.type).toBe("order_filled");
    if (parsed.type !== "order_filled") return;
    const events = orderFilledToLedgerEvents(parsed.event, PROXY, 1);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("SELL");
    expect(events[0].shares).toBeCloseTo(793.17, 2);
    expect(events[0].cashUsd).toBeCloseTo(792.38, 2);
  });

  it("maps maker SELL when compact id 1 + full outcome id (neg-risk)", () => {
    const log = negRiskLog({
      maker: PROXY,
      taker: NEG_RISK_CTF_EXCHANGE_ADDRESS,
      makerAssetId: 1n,
      takerAssetId: BigInt(SPAIN_ASSET),
      makerAmount: 793_170_000n,
      takerAmount: 792_376_830n,
    });
    const parsed = decodeLog(log);
    expect(parsed.type).toBe("order_filled");
    if (parsed.type !== "order_filled") return;
    const events = orderFilledToLedgerEvents(parsed.event, PROXY, 1);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("SELL");
    expect(events[0].asset).toBe(SPAIN_ASSET);
    expect(events[0].shares).toBeCloseTo(793.17, 2);
  });
});
