import { describe, expect, it, vi } from "vitest";
import { logStderr, logStdout } from "@/lib/utils";

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
