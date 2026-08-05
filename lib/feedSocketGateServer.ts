import "server-only";

import {
  createFeedSocketGateHandlers,
  passesFeedSocketStakeGate,
} from "@/lib/feedSocketGateLogic";
import {
  resolvePipelineEvBatchServer,
  resolvePipelineTradeEvServer,
} from "@/lib/pipelineEvServer";

const { passesFeedSocketTradeEvGate, shouldBroadcastQualifiedSocketTrade } =
  createFeedSocketGateHandlers(
    resolvePipelineEvBatchServer,
    resolvePipelineTradeEvServer
  );

export {
  passesFeedSocketStakeGate,
  passesFeedSocketTradeEvGate,
  shouldBroadcastQualifiedSocketTrade,
};
