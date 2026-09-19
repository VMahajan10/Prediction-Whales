#!/usr/bin/env tsx
/**
 * One-shot Etherscan V2 (Polygon) availability probe.
 *
 * Does not fetch wallet history and does not fall back to RPC.
 *
 *   npm run check:indexed-provider
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import {
  EtherscanV2LogProvider,
  getEtherscanErrorMessage,
  isEtherscanEmptySuccess,
} from "@/lib/walletLedger/indexed/providers/etherscan";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

const ETHERSCAN_V2_BASE = "https://api.etherscan.io/v2/api";
const POLYGON_CHAIN_ID = "137";
const PROBE_ADDRESS = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";
const PROBE_TOPIC0 =
  "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6";
const PROBE_FROM_BLOCK = "91800000";
const PROBE_TO_BLOCK = "91801000";

function redactSecret(value: string, secret: string | null): string {
  if (!secret) return value;
  return value.split(secret).join("[REDACTED]");
}

function resultTypeOf(result: unknown): string {
  if (result === null) return "null";
  if (result === undefined) return "undefined";
  if (Array.isArray(result)) return `array(length=${result.length})`;
  return typeof result;
}

function isEmptySuccess(json: {
  status?: unknown;
  message?: unknown;
  result?: unknown;
}): boolean {
  return isEtherscanEmptySuccess(json);
}

function classifyReason(input: {
  apiKeyConfigured: boolean;
  httpStatus: number | null;
  networkError: string | null;
  etherscanStatus: string | null;
  etherscanMessage: string | null;
  resultType: string;
  resultPreview: string;
}): { available: boolean; reason: string } {
  if (!input.apiKeyConfigured) {
    return { available: false, reason: "ETHERSCAN_API_KEY is not set in this process." };
  }
  if (input.networkError) {
    return { available: false, reason: `Network/parse error: ${input.networkError}` };
  }
  if (input.httpStatus == null) {
    return { available: false, reason: "No HTTP response." };
  }
  if (input.httpStatus < 200 || input.httpStatus >= 300) {
    return {
      available: false,
      reason: `HTTP ${input.httpStatus} from Etherscan V2.`,
    };
  }

  const status = input.etherscanStatus ?? "";
  const message = input.etherscanMessage ?? "";
  const combined = `${message} ${input.resultPreview}`.toLowerCase();

  if (status === "1") {
    return { available: true, reason: "Etherscan returned status=1 (OK)." };
  }

  if (
    /no records found/i.test(message) ||
    (status === "0" && input.resultType.startsWith("array(length=0)") && !/notok/i.test(message))
  ) {
    return {
      available: true,
      reason:
        "Empty-but-successful getLogs (status=0 / no records). Provider is reachable; probe must not treat this as unavailable.",
    };
  }

  if (/invalid.?api.?key|missing.?api.?key|invalid api key/i.test(combined)) {
    return { available: false, reason: "Etherscan rejected the API key (auth)." };
  }
  if (/rate|max calls|limit reached/i.test(combined)) {
    return { available: false, reason: "Etherscan rate limit / quota." };
  }
  if (/unsupported chain|missing or unsupported chainid|chainid/i.test(combined)) {
    return { available: false, reason: "Chain not supported or chainid missing/wrong." };
  }
  if (/free api access is not supported|not available|upgrade|api pro|plan/i.test(combined)) {
    return { available: false, reason: "API plan does not include this chain or endpoint." };
  }
  if (/notok/i.test(message) || status === "0") {
    return {
      available: false,
      reason: `Etherscan error: status=${status || "?"} message=${message || "?"} result=${input.resultPreview || "?"}`,
    };
  }

  return {
    available: false,
    reason: `Unexpected Etherscan payload: status=${status || "?"} message=${message || "?"}`,
  };
}

function previewResult(result: unknown, secret: string | null): string {
  if (result == null) return String(result);
  if (Array.isArray(result)) return result.length === 0 ? "[]" : `[${result.length} logs]`;
  if (typeof result === "string") {
    const trimmed = result.slice(0, 240);
    return redactSecret(trimmed, secret);
  }
  try {
    return redactSecret(JSON.stringify(result).slice(0, 240), secret);
  } catch {
    return typeof result;
  }
}

async function main(): Promise<void> {
  const apiKey =
    process.env.ETHERSCAN_API_KEY?.trim() ||
    process.env.POLYGONSCAN_API_KEY?.trim() ||
    null;
  const apiKeyConfigured = Boolean(apiKey);
  const keySource = process.env.ETHERSCAN_API_KEY?.trim()
    ? "ETHERSCAN_API_KEY"
    : process.env.POLYGONSCAN_API_KEY?.trim()
      ? "POLYGONSCAN_API_KEY"
      : "none";

  const url = new URL(ETHERSCAN_V2_BASE);
  url.searchParams.set("chainid", POLYGON_CHAIN_ID);
  url.searchParams.set("module", "logs");
  url.searchParams.set("action", "getLogs");
  url.searchParams.set("fromBlock", PROBE_FROM_BLOCK);
  url.searchParams.set("toBlock", PROBE_TO_BLOCK);
  url.searchParams.set("address", PROBE_ADDRESS);
  url.searchParams.set("topic0", PROBE_TOPIC0);
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", "1");
  const apiKeyIncluded = Boolean(apiKey);
  if (apiKey) url.searchParams.set("apikey", apiKey);

  const endpointWithoutKey = new URL(ETHERSCAN_V2_BASE);
  endpointWithoutKey.searchParams.set("chainid", POLYGON_CHAIN_ID);
  endpointWithoutKey.searchParams.set("module", "logs");
  endpointWithoutKey.searchParams.set("action", "getLogs");
  endpointWithoutKey.searchParams.set("fromBlock", PROBE_FROM_BLOCK);
  endpointWithoutKey.searchParams.set("toBlock", PROBE_TO_BLOCK);
  endpointWithoutKey.searchParams.set("address", PROBE_ADDRESS);
  endpointWithoutKey.searchParams.set("topic0", PROBE_TOPIC0);
  endpointWithoutKey.searchParams.set("page", "1");
  endpointWithoutKey.searchParams.set("offset", "1");
  endpointWithoutKey.searchParams.set("apikey", apiKeyIncluded ? "[REDACTED]" : "(omitted)");

  let httpStatus: number | null = null;
  let networkError: string | null = null;
  let etherscanStatus: string | null = null;
  let etherscanMessage: string | null = null;
  let resultType = "n/a";
  let resultPreview = "";
  let rawProbeAvailable: boolean | null = null;
  let rawProbeError: string | null = null;

  if (apiKey) {
    try {
      const res = await fetchWithTimeout(url.toString(), { timeoutMs: 15_000 });
      httpStatus = res.status;
      const json = (await res.json()) as {
        status?: unknown;
        message?: unknown;
        result?: unknown;
      };
      etherscanStatus = json.status == null ? null : String(json.status);
      etherscanMessage = json.message == null ? null : String(json.message);
      resultType = resultTypeOf(json.result);
      resultPreview = previewResult(json.result, apiKey);
    } catch (error) {
      networkError = error instanceof Error ? error.message : String(error);
    }
  }

  const provider = new EtherscanV2LogProvider();
  const probe = await provider.probe();
  rawProbeAvailable = probe.available;
  rawProbeError = probe.error;

  const classified = classifyReason({
    apiKeyConfigured,
    httpStatus,
    networkError,
    etherscanStatus,
    etherscanMessage,
    resultType,
    resultPreview,
  });

  const probeErrorDisplay =
    rawProbeError == null ? "null" : rawProbeError === "" ? "<empty string>" : rawProbeError;

  console.log("Provider: Etherscan V2");
  console.log(`API key configured: ${apiKeyConfigured ? "yes" : "no"} (${keySource})`);
  console.log("Chain: Polygon (137)");
  console.log(`Endpoint: ${endpointWithoutKey.toString()}`);
  console.log(`API key included in query: ${apiKeyIncluded ? "yes" : "no"}`);
  console.log(`HTTP: ${httpStatus ?? (networkError ? "error" : "n/a")}`);
  console.log(`Etherscan status: ${etherscanStatus ?? "n/a"}`);
  console.log(`Etherscan message: ${etherscanMessage ?? "n/a"}`);
  console.log(`Etherscan result type: ${resultType}`);
  console.log(`Etherscan result preview: ${resultPreview || "n/a"}`);
  console.log(`Available: ${classified.available ? "YES" : "NO"}`);
  console.log(`Reason: ${classified.reason}`);
  console.log(`Current probe() available: ${rawProbeAvailable}`);
  console.log(`Current probe() error: ${probeErrorDisplay}`);
  console.log(`Current probe() latency: ${probe.probeLatencyMs}ms`);

  if (
    classified.available &&
    rawProbeAvailable === false &&
    (rawProbeError == null || rawProbeError === "")
  ) {
    console.log(
      "Root cause: probe() treats json.status !== \"1\" as unavailable and String(result) of [] is \"\", so error= is blank."
    );
  }

  if (!classified.available) process.exitCode = 1;
}

void main().catch((error) => {
  console.error("[check:indexed-provider] failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
