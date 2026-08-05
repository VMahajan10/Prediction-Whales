"use client";

import { fetchPipelineEvBatch, fetchPipelineTradeEv } from "@/lib/pipelineEvClient";
import {
  createFeedSocketGateHandlers,
  passesFeedSocketStakeGate,
} from "@/lib/feedSocketGateLogic";

const { passesFeedSocketTradeEvGate, shouldBroadcastQualifiedSocketTrade } =
  createFeedSocketGateHandlers(fetchPipelineEvBatch, fetchPipelineTradeEv);

export {
  passesFeedSocketStakeGate,
  passesFeedSocketTradeEvGate,
  shouldBroadcastQualifiedSocketTrade,
};
