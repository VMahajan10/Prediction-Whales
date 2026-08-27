import {
  CONDITIONAL_TOKENS_ADDRESS,
  ORDER_FILLED_TOPICS,
  TOPIC_CONDITION_RESOLUTION,
  TOPIC_ERC1155_TRANSFER_SINGLE,
  TOPIC_ORDER_FILLED_V1,
  TOPIC_ORDER_FILLED_NEG_RISK,
  TOPIC_PAYOUT_REDEMPTION,
  TOPIC_POSITION_SPLIT,
  TOPIC_POSITIONS_MERGE,
} from "@/lib/walletLedger/onchain/contracts";
import { parseBlockNumber } from "@/lib/walletLedger/onchain/rpc";
import type {
  ParsedConditionResolution,
  ParsedErc1155Transfer,
  ParsedOnChainEvent,
  ParsedOrderFilled,
  ParsedPayoutRedemption,
  ParsedPositionSplit,
  ParsedPositionsMerge,
  RpcLog,
} from "@/lib/walletLedger/onchain/types";

export function topicToAddress(topic: string | undefined): string | null {
  if (!topic || topic.length !== 66) return null;
  return (`0x${topic.slice(26)}`).toLowerCase();
}

function readUint256(data: string, wordIndex: number): bigint {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  const start = wordIndex * 64;
  const word = body.slice(start, start + 64);
  if (!word) return 0n;
  return BigInt(`0x${word}`);
}

function readUint256Array(data: string, offsetWordIndex: number): bigint[] {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  const offset = Number(readUint256(`0x${body}`, offsetWordIndex));
  const lengthStart = offset * 2;
  const length = Number(BigInt(`0x${body.slice(lengthStart, lengthStart + 64)}`));
  const values: bigint[] = [];
  for (let i = 0; i < length; i += 1) {
    const start = lengthStart + 64 + i * 64;
    values.push(BigInt(`0x${body.slice(start, start + 64)}`));
  }
  return values;
}

export function decodeOrderFilledV1(log: RpcLog): ParsedOrderFilled | null {
  if (log.topics[0]?.toLowerCase() !== TOPIC_ORDER_FILLED_V1) return null;
  const maker = topicToAddress(log.topics[2]);
  const taker = topicToAddress(log.topics[3]);
  if (!maker || !taker) return null;
  return {
    kind: "order_filled_v1",
    orderHash: log.topics[1] ?? "",
    maker,
    taker,
    makerAssetId: readUint256(log.data, 0).toString(),
    takerAssetId: readUint256(log.data, 1).toString(),
    makerAmountFilled: readUint256(log.data, 2),
    takerAmountFilled: readUint256(log.data, 3),
    fee: readUint256(log.data, 4),
    blockNumber: parseBlockNumber(log.blockNumber),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: Number.parseInt(log.logIndex, 16),
    contractAddress: log.address.toLowerCase(),
  };
}

/** Neg-risk OrderFilled shares indexed maker/taker; data layout differs — decode amounts when possible. */
export function decodeOrderFilledNegRisk(log: RpcLog): ParsedOrderFilled | null {
  if (log.topics[0]?.toLowerCase() !== TOPIC_ORDER_FILLED_NEG_RISK) return null;
  const maker = topicToAddress(log.topics[2]);
  const taker = topicToAddress(log.topics[3]);
  if (!maker || !taker) return null;
  const dataWords = (log.data.length - 2) / 64;
  return {
    kind: "order_filled_neg_risk",
    orderHash: log.topics[1] ?? "",
    maker,
    taker,
    makerAssetId: dataWords >= 2 ? readUint256(log.data, 0).toString() : "0",
    takerAssetId: dataWords >= 2 ? readUint256(log.data, 1).toString() : "0",
    makerAmountFilled: dataWords >= 4 ? readUint256(log.data, 2) : 0n,
    takerAmountFilled: dataWords >= 4 ? readUint256(log.data, 3) : 0n,
    fee: dataWords >= 5 ? readUint256(log.data, 4) : undefined,
    blockNumber: parseBlockNumber(log.blockNumber),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: Number.parseInt(log.logIndex, 16),
    contractAddress: log.address.toLowerCase(),
  };
}

export function decodeErc1155TransferSingle(
  log: RpcLog
): ParsedErc1155Transfer | null {
  if (log.topics[0]?.toLowerCase() !== TOPIC_ERC1155_TRANSFER_SINGLE) {
    return null;
  }
  if (log.address.toLowerCase() !== CONDITIONAL_TOKENS_ADDRESS) return null;
  const operator = topicToAddress(log.topics[1]);
  const from = topicToAddress(log.topics[2]);
  const to = topicToAddress(log.topics[3]);
  if (!operator || !from || !to) return null;
  return {
    operator,
    from,
    to,
    tokenId: readUint256(log.data, 0).toString(),
    value: readUint256(log.data, 1),
    blockNumber: parseBlockNumber(log.blockNumber),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: Number.parseInt(log.logIndex, 16),
  };
}

export function decodeConditionResolution(
  log: RpcLog
): ParsedConditionResolution | null {
  if (log.topics[0]?.toLowerCase() !== TOPIC_CONDITION_RESOLUTION) return null;
  if (log.address.toLowerCase() !== CONDITIONAL_TOKENS_ADDRESS) return null;
  const conditionId = log.topics[1];
  const oracle = topicToAddress(log.topics[2]);
  const questionId = log.topics[3];
  if (!conditionId || !oracle || !questionId) return null;
  return {
    conditionId: conditionId.toLowerCase(),
    oracle,
    questionId: questionId.toLowerCase(),
    outcomeSlotCount: Number(readUint256(log.data, 0)),
    payoutNumerators: readUint256Array(log.data, 1),
    blockNumber: parseBlockNumber(log.blockNumber),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: Number.parseInt(log.logIndex, 16),
  };
}

export function decodePositionSplit(log: RpcLog): ParsedPositionSplit | null {
  if (log.topics[0]?.toLowerCase() !== TOPIC_POSITION_SPLIT) return null;
  if (log.address.toLowerCase() !== CONDITIONAL_TOKENS_ADDRESS) return null;
  const stakeholder = topicToAddress(log.topics[1]);
  const parentCollectionId = log.topics[2];
  const conditionId = log.topics[3];
  if (!stakeholder || !parentCollectionId || !conditionId) return null;
  const collateralWord = readUint256(log.data, 0);
  const collateralHex = collateralWord.toString(16).padStart(40, "0");
  return {
    stakeholder,
    collateralToken: `0x${collateralHex.slice(-40)}`.toLowerCase(),
    parentCollectionId: parentCollectionId.toLowerCase(),
    conditionId: conditionId.toLowerCase(),
    amount: readUint256(log.data, 2),
    blockNumber: parseBlockNumber(log.blockNumber),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: Number.parseInt(log.logIndex, 16),
  };
}

export function decodePositionsMerge(log: RpcLog): ParsedPositionsMerge | null {
  if (log.topics[0]?.toLowerCase() !== TOPIC_POSITIONS_MERGE) return null;
  if (log.address.toLowerCase() !== CONDITIONAL_TOKENS_ADDRESS) return null;
  const stakeholder = topicToAddress(log.topics[1]);
  const parentCollectionId = log.topics[2];
  const conditionId = log.topics[3];
  if (!stakeholder || !parentCollectionId || !conditionId) return null;
  const collateralWord = readUint256(log.data, 0);
  const collateralHex = collateralWord.toString(16).padStart(40, "0");
  return {
    stakeholder,
    collateralToken: `0x${collateralHex.slice(-40)}`.toLowerCase(),
    parentCollectionId: parentCollectionId.toLowerCase(),
    conditionId: conditionId.toLowerCase(),
    amount: readUint256(log.data, 2),
    blockNumber: parseBlockNumber(log.blockNumber),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: Number.parseInt(log.logIndex, 16),
  };
}

export function decodePayoutRedemption(
  log: RpcLog
): ParsedPayoutRedemption | null {
  if (log.topics[0]?.toLowerCase() !== TOPIC_PAYOUT_REDEMPTION) return null;
  if (log.address.toLowerCase() !== CONDITIONAL_TOKENS_ADDRESS) return null;
  const redeemer = topicToAddress(log.topics[1]);
  const collateralToken = topicToAddress(log.topics[2]);
  const parentCollectionId = log.topics[3];
  if (!redeemer || !collateralToken || !parentCollectionId) return null;
  const conditionIdWord = readUint256(log.data, 0);
  const conditionHex = conditionIdWord.toString(16).padStart(64, "0");
  return {
    redeemer,
    collateralToken,
    parentCollectionId: parentCollectionId.toLowerCase(),
    conditionId: `0x${conditionHex}`.toLowerCase(),
    payout: readUint256(log.data, 2),
    blockNumber: parseBlockNumber(log.blockNumber),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: Number.parseInt(log.logIndex, 16),
  };
}

export function decodeLog(log: RpcLog): ParsedOnChainEvent {
  const orderV1 = decodeOrderFilledV1(log);
  if (orderV1) return { type: "order_filled", event: orderV1 };
  const orderNeg = decodeOrderFilledNegRisk(log);
  if (orderNeg) return { type: "order_filled", event: orderNeg };
  const transfer = decodeErc1155TransferSingle(log);
  if (transfer) return { type: "erc1155_transfer", event: transfer };
  const resolution = decodeConditionResolution(log);
  if (resolution) return { type: "condition_resolution", event: resolution };
  const split = decodePositionSplit(log);
  if (split) return { type: "position_split", event: split };
  const merge = decodePositionsMerge(log);
  if (merge) return { type: "positions_merge", event: merge };
  const redeem = decodePayoutRedemption(log);
  if (redeem) return { type: "payout_redemption", event: redeem };

  if (ORDER_FILLED_TOPICS.includes(log.topics[0]?.toLowerCase() as never)) {
    return { type: "unparsed", raw: log, reason: "order_filled_decode_failed" };
  }
  return { type: "unparsed", raw: log, reason: "unknown_event" };
}

export function orderFilledInvolvesWallet(
  event: ParsedOrderFilled,
  wallet: string
): boolean {
  const w = wallet.toLowerCase();
  return event.maker === w || event.taker === w;
}

export function tokenAmountToNumber(amount: bigint): number {
  return Number(amount) / 1_000_000;
}
