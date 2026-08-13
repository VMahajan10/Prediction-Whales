import assert from "node:assert/strict";
import { publicApiErrorMessage } from "../lib/apiError";

function withNodeEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.NODE_ENV;
  if (value === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previous;
    }
  }
}

{
  const devMessage = withNodeEnv("development", () =>
    publicApiErrorMessage(new Error("db connection refused"), "fallback")
  );
  assert.equal(devMessage, "db connection refused");

  const prodMessage = withNodeEnv("production", () =>
    publicApiErrorMessage(new Error("db connection refused"), "fallback")
  );
  assert.equal(prodMessage, "fallback");

  const defaultFallback = withNodeEnv("production", () =>
    publicApiErrorMessage("raw string leak")
  );
  assert.equal(defaultFallback, "An unexpected error occurred");

  console.log("✓ apiError.test.ts");
}
