import { afterEach, describe, expect, it } from "vitest";
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

describe("publicApiErrorMessage", () => {
  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it("returns the error message in development", () => {
    const devMessage = withNodeEnv("development", () =>
      publicApiErrorMessage(new Error("db connection refused"), "fallback")
    );
    expect(devMessage).toBe("db connection refused");
  });

  it("returns the fallback in production", () => {
    const prodMessage = withNodeEnv("production", () =>
      publicApiErrorMessage(new Error("db connection refused"), "fallback")
    );
    expect(prodMessage).toBe("fallback");
  });

  it("uses the default fallback for non-error values in production", () => {
    const defaultFallback = withNodeEnv("production", () =>
      publicApiErrorMessage("raw string leak")
    );
    expect(defaultFallback).toBe("An unexpected error occurred");
  });
});
