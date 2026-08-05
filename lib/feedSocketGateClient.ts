"use client";

import { fetchPipelineEvBatch, fetchPipelineTradeEv } from "@/lib/pipelineEvClient";
import {
  createFeedSocketGateHandlers,
  passesFeedSocketStakeGate,
  passesRawIngestionSocketStakeGate,
} from "@/lib/feedSocketGateLogic";

const { passesFeedSocketTradeEvGate, shouldBroadcastQualifiedSocketTrade } =
  createFeedSocketGateHandlers(fetchPipelineEvBatch, fetchPipelineTradeEv);

export {
  passesFeedSocketStakeGate,
  passesFeedSocketTradeEvGate,
  passesRawIngestionSocketStakeGate,
  shouldBroadcastQualifiedSocketTrade,
};
