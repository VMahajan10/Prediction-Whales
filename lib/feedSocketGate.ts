import { fetchPipelineEvBatch, fetchPipelineTradeEv } from "@/lib/pipelineEvClient";
import {
  createFeedSocketGateHandlers,
  passesFeedSocketStakeGate,
} from "@/lib/feedSocketGateShared";

const { passesFeedSocketTradeEvGate, shouldBroadcastQualifiedSocketTrade } =
  createFeedSocketGateHandlers(fetchPipelineEvBatch, fetchPipelineTradeEv);

export { passesFeedSocketStakeGate, passesFeedSocketTradeEvGate, shouldBroadcastQualifiedSocketTrade };
