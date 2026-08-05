/**
 * Render / Node worker feed socket gate — in-process EV via pipelineEvServer.
 * Do not add `import "server-only"` here: that package throws in plain Node workers.
 * Browser code must use `feedSocketGateClient` (HTTP to /api/ev/trades).
 */
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
