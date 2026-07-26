import { describe, expect, it, vi } from "vitest";
import { formatToEST, logStderr, logStdout } from "@/lib/utils";

describe("formatToEST", () => {
  it("formats a Date in America/New_York with a short zone label", () => {
    const formatted = formatToEST(new Date("2026-01-15T18:30:00.000Z"));
    expect(formatted).toMatch(/Jan/);
    expect(formatted).toMatch(/2026/);
    expect(formatted).toMatch(/E[DS]T/);
  });

  it("accepts unix seconds", () => {
    const formatted = formatToEST(1_700_000_000);
    expect(formatted).not.toBe("Invalid date");
  });

  it("accepts ISO strings", () => {
    const formatted = formatToEST("2026-03-10T12:00:00.000Z");
    expect(formatted).not.toBe("Invalid date");
  });
});

describe("logStdout / logStderr", () => {
  it("writes line-delimited output to stdout/stderr", () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    logStdout("hello", "world");
    logStderr("error", 1);

    expect(stdoutSpy).toHaveBeenCalledWith("hello world\n");
    expect(stderrSpy).toHaveBeenCalledWith("error 1\n");

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
