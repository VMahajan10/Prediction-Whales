import assert from "node:assert/strict";
import { kalshiFetch, sleep } from "@/lib/kalshi/http";

const originalFetch = globalThis.fetch;

async function withMockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
  fn: () => Promise<void>
): Promise<void> {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return handler(url, init);
  }) as typeof fetch;

  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function test429RetriesUntilSuccess(): Promise<void> {
  let attempts = 0;

  await withMockFetch(async () => {
    attempts += 1;
    if (attempts < 3) {
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }, async () => {
    const res = await kalshiFetch("/markets", { label: "test-429" });
    assert.equal(res.status, 200);
    assert.equal(attempts, 3);
  });

  console.log("✓ kalshiFetch retries on 429 until success");
}

async function test429ExhaustsAttempts(): Promise<void> {
  let attempts = 0;

  await withMockFetch(async () => {
    attempts += 1;
    return new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "0" },
    });
  }, async () => {
    const res = await kalshiFetch("/markets", {
      label: "test-429-exhaust",
      maxAttempts: 3,
    });
    assert.equal(res.status, 429);
    assert.equal(attempts, 3);
  });

  console.log("✓ kalshiFetch returns 429 after max attempts");
}

async function testSleep(): Promise<void> {
  const start = Date.now();
  await sleep(50);
  assert.ok(Date.now() - start >= 40);
  console.log("✓ sleep waits");
}

async function main(): Promise<void> {
  await test429RetriesUntilSuccess();
  await test429ExhaustsAttempts();
  await testSleep();
  console.log("All kalshi/http tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
