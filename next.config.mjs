import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Stub modules substituted in the browser bundle so server-only paths fail at build time, not runtime. */
const CLIENT_STUBS = {
  "@/lib/pipelineEvServer": "./lib/stubs/client-stub.ts",
  "@/lib/feedSocketGateWorker": "./lib/stubs/client-stub.ts",
  "@/lib/feedTradeEvServer": "./lib/stubs/client-stub.ts",
  "@/lib/feedQualificationServer": "./lib/stubs/client-stub.ts",
  "@/lib/feed/kalshiFeedCandidatesServer": "./lib/stubs/client-stub.ts",
  "@/lib/feed/feedTradeHistory": "./lib/stubs/client-stub.ts",
  "@/lib/kalshiTrades": "./lib/stubs/client-stub.ts",
  "@/lib/kalshiTradesServer": "./lib/stubs/client-stub.ts",
  "@/lib/feed/recentTradesServer": "./lib/stubs/client-stub.ts",
  "@/lib/x-agent/gates": "./lib/stubs/client-stub.ts",
  "@/lib/x-agent/batchedNeonWrites": "./lib/stubs/client-stub.ts",
  "@/lib/x-agent/kalshiShadowTrades": "./lib/stubs/client-stub.ts",
  "@/lib/x-agent/xPublisherScheduler": "./lib/stubs/client-stub.ts",
  "@/lib/x-agent/shadowTradeQualification": "./lib/stubs/client-stub.ts",
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack(config, { isServer }) {
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        ...Object.fromEntries(
          Object.entries(CLIENT_STUBS).map(([key, rel]) => [
            key,
            path.resolve(__dirname, rel),
          ])
        ),
      };
    }
    return config;
  },
};

export default nextConfig;
