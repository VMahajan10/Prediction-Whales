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
