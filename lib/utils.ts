import util from "node:util";

function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => (typeof arg === "string" ? arg : util.format("%o", arg)))
    .join(" ");
}

/** Line-delimited stdout for hosted workers (Render) — server-only. */
export function logStdout(...args: unknown[]): void {
  process.stdout.write(`${formatLogArgs(args)}\n`);
}

/** Line-delimited stderr for hosted workers (Render) — server-only. */
export function logStderr(...args: unknown[]): void {
  process.stderr.write(`${formatLogArgs(args)}\n`);
}
