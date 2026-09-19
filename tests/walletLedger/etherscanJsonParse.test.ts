import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  EtherscanQueryMaxRuntimeError,
} from "@/lib/walletLedger/indexed/etherscanErrors";
import {
  ETHERSCAN_JSON_PARSE_WORKER_THRESHOLD_BYTES,
  parseEtherscanJsonBody,
} from "@/lib/walletLedger/indexed/etherscanJsonParse";

function buildEtherscanLikeBody(logCount: number): string {
  const logs = Array.from({ length: logCount }, (_, index) => ({
    address: "0x4bfb41d5e6f69da32d511c6a0cd4706e4158893c",
    topics: [
      "0xc3d58168c5ae7397731d063d5bbf3d657c54c74ec478a3677dc770f9ee3e2d6",
      "0x0000000000000000000000005a218c7ad04135830a45c41aaed7294df7809318",
    ],
    data: "0x00000000000000000000000000000000000000000000000000000000000003e8",
    blockNumber: `0x${(56_000_000 + index).toString(16)}`,
    transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
    transactionIndex: "0x0",
    blockHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    logIndex: "0x0",
    removed: false,
  }));
  return JSON.stringify({ status: "1", message: "OK", result: logs });
}

describe("etherscanJsonParse", () => {
  it("uses the in-process path for small bodies", async () => {
    const body = JSON.stringify({ status: "1", message: "OK", result: [] });
    expect(body.length).toBeLessThan(ETHERSCAN_JSON_PARSE_WORKER_THRESHOLD_BYTES);
    const parsed = await parseEtherscanJsonBody(body);
    expect(parsed.status).toBe("1");
    expect(parsed.result).toEqual([]);
  });

  it("worker path matches JSON.parse for large bodies", async () => {
    const body = buildEtherscanLikeBody(1_000);
    expect(body.length).toBeGreaterThan(ETHERSCAN_JSON_PARSE_WORKER_THRESHOLD_BYTES);
    const expected = JSON.parse(body) as { status: string; result: unknown[] };
    const parsed = await parseEtherscanJsonBody(body);
    expect(parsed).toEqual(expected);
  });

  it("propagates malformed JSON errors", async () => {
    const body = "{".padEnd(ETHERSCAN_JSON_PARSE_WORKER_THRESHOLD_BYTES + 1, "{");
    await expect(parseEtherscanJsonBody(body)).rejects.toThrow();
  });

  it("aborts large parse promptly and reaps the worker", async () => {
    const body = buildEtherscanLikeBody(2_000);
    const controller = new AbortController();
    const started = Date.now();
    const promise = parseEtherscanJsonBody(body, controller.signal);
    setTimeout(() => controller.abort(new EtherscanQueryMaxRuntimeError("abort")), 25);
    await expect(promise).rejects.toBeInstanceOf(EtherscanQueryMaxRuntimeError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
