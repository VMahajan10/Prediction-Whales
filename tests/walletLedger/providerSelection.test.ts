import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyProbeFailure,
  isPermanentProbeFailure,
  isTransientProbeFailure,
  probeProviderWithRetry,
} from "@/lib/walletLedger/indexed/providerProbe";
import {
  clearCachedProviderEvaluations,
  selectBestAvailableProvider,
} from "@/lib/walletLedger/indexed/providers/registry";
import { EtherscanV2LogProvider } from "@/lib/walletLedger/indexed/providers/etherscan";
import { FullHistoryRpcProvider } from "@/lib/walletLedger/indexed/providers/fullHistoryRpc";
import type {
  IndexedProviderEvaluation,
  IndexedProviderProbeResult,
} from "@/lib/walletLedger/indexed/types";

function etherscanProbe(
  available: boolean,
  error: string | null = null
): IndexedProviderProbeResult {
  return {
    providerId: "etherscan_v2",
    available,
    probeLatencyMs: 10,
    error,
    capabilities: {
      walletTopicFilter: true,
      contractFilter: true,
      blockRangeFilter: true,
      txHashLookup: true,
      cursorPagination: false,
      pagePagination: true,
      maxBlockRangePerRequest: 5000,
      maxResultsPerPage: 1000,
      requiresApiKey: true,
      estimatedCostTier: "freemium",
    },
    notes: error?.includes("timeout") ? ["probe_network_error"] : [],
  };
}

function evaluation(
  providerId: IndexedProviderEvaluation["providerId"],
  available: boolean,
  error: string | null = null,
  probeAttempts = 1
): IndexedProviderEvaluation {
  return {
    providerId,
    probe:
      providerId === "etherscan_v2"
        ? etherscanProbe(available, error)
        : {
            providerId,
            available,
            probeLatencyMs: 5,
            error,
            capabilities: {
              walletTopicFilter: false,
              contractFilter: true,
              blockRangeFilter: true,
              txHashLookup: false,
              cursorPagination: false,
              pagePagination: false,
              maxBlockRangePerRequest: null,
              maxResultsPerPage: null,
              requiresApiKey: false,
              estimatedCostTier: "free",
            },
            notes: [],
          },
    probeAttempts,
  };
}

describe("providerProbe classification", () => {
  it("classifies transient network failures", () => {
    expect(isTransientProbeFailure("Request timed out", ["probe_network_error"])).toBe(
      true
    );
    expect(isTransientProbeFailure("ETIMEDOUT")).toBe(true);
    expect(isTransientProbeFailure("ECONNRESET")).toBe(true);
    expect(isTransientProbeFailure("rate limit exceeded")).toBe(true);
    expect(isTransientProbeFailure("http_503")).toBe(true);
  });

  it("classifies permanent auth/config failures", () => {
    expect(isPermanentProbeFailure("missing_api_key")).toBe(true);
    expect(isPermanentProbeFailure("Invalid API Key")).toBe(true);
    expect(isPermanentProbeFailure("http_403")).toBe(true);
    expect(classifyProbeFailure("unsupported chain")).toBe("permanent");
  });
});

describe("probeProviderWithRetry", () => {
  it("retries transient timeout then succeeds", async () => {
    const provider = {
      id: "etherscan_v2" as const,
      probe: vi
        .fn()
        .mockResolvedValueOnce(etherscanProbe(false, "Request timed out"))
        .mockResolvedValueOnce(etherscanProbe(true)),
    };
    const result = await probeProviderWithRetry(provider as never, {
      maxAttempts: 3,
    });
    expect(result.attempts).toBe(2);
    expect(result.probe.available).toBe(true);
    expect(provider.probe).toHaveBeenCalledTimes(2);
  });

  it("fails immediately on invalid API key without retry", async () => {
    const provider = {
      id: "etherscan_v2" as const,
      probe: vi.fn().mockResolvedValue(etherscanProbe(false, "Invalid API Key")),
    };
    const result = await probeProviderWithRetry(provider as never, {
      maxAttempts: 3,
    });
    expect(result.attempts).toBe(1);
    expect(provider.probe).toHaveBeenCalledTimes(1);
  });

  it("fails after all transient retries are exhausted", async () => {
    const provider = {
      id: "etherscan_v2" as const,
      probe: vi
        .fn()
        .mockResolvedValue(etherscanProbe(false, "Request timed out")),
    };
    const result = await probeProviderWithRetry(provider as never, {
      maxAttempts: 3,
    });
    expect(result.attempts).toBe(3);
    expect(result.probe.available).toBe(false);
    expect(provider.probe).toHaveBeenCalledTimes(3);
  });
});

describe("selectBestAvailableProvider", () => {
  afterEach(() => {
    clearCachedProviderEvaluations();
    vi.restoreAllMocks();
  });

  it("reuses successful evaluation without a second probe", async () => {
    const probeSpy = vi.spyOn(EtherscanV2LogProvider.prototype, "probe");
    const evaluations = [evaluation("etherscan_v2", true)];

    const result = await selectBestAvailableProvider("etherscan_v2", {
      evaluations,
    });

    expect(probeSpy).not.toHaveBeenCalled();
    expect(result.reusedEvaluation).toBe(true);
    expect(result.probe.available).toBe(true);
    expect(result.provider.id).toBe("etherscan_v2");
  });

  it("fails fast when explicit etherscan remains unavailable after retries", async () => {
    vi.spyOn(EtherscanV2LogProvider.prototype, "probe").mockResolvedValue(
      etherscanProbe(false, "Request timed out")
    );

    await expect(
      selectBestAvailableProvider("etherscan_v2", { evaluations: [] })
    ).rejects.toThrow(/refusing full_history_rpc fallback/);

    expect(FullHistoryRpcProvider.prototype).toBeDefined();
    expect(EtherscanV2LogProvider.prototype.probe).toHaveBeenCalledTimes(3);
  });

  it("never falls back to RPC when explicit etherscan is requested", async () => {
    const rpcSpy = vi.spyOn(FullHistoryRpcProvider.prototype, "probe");
    vi.spyOn(EtherscanV2LogProvider.prototype, "probe").mockResolvedValue(
      etherscanProbe(false, "Invalid API Key")
    );

    await expect(
      selectBestAvailableProvider("etherscan_v2", { evaluations: [] })
    ).rejects.toThrow(/refusing full_history_rpc fallback/);

    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("probes with retry when no cached evaluation exists", async () => {
    const probeSpy = vi
      .spyOn(EtherscanV2LogProvider.prototype, "probe")
      .mockResolvedValueOnce(etherscanProbe(false, "ETIMEDOUT"))
      .mockResolvedValueOnce(etherscanProbe(true));

    const result = await selectBestAvailableProvider("etherscan_v2", {
      evaluations: [],
    });

    expect(probeSpy).toHaveBeenCalledTimes(2);
    expect(result.reusedEvaluation).toBe(false);
    expect(result.probeAttempts).toBe(2);
    expect(result.provider.id).toBe("etherscan_v2");
  });
});
