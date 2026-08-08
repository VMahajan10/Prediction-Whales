/**
 * Loaded before any worker/app modules so process.env is populated locally.
 * Keep this file free of imports from lib/* or queue/email code.
 */
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import Module from "node:module";
import { join } from "node:path";

/**
 * `server-only` is a marker package whose implementation is an unconditional
 * `throw`; it is only inert when the resolver applies React's `react-server`
 * export condition. Next.js does that, bare `node` does not — so the compiled
 * worker dies on import. The worker legitimately shares these modules with the
 * app, so neutralize the marker at the worker entry rather than dropping it
 * from `lib/*` and losing the client-bundle guardrail.
 */
type ModuleLoader = (request: string, ...rest: unknown[]) => unknown;
const internalModule = Module as unknown as { _load: ModuleLoader };
const loadModule = internalModule._load;

internalModule._load = function patchedLoad(
  this: unknown,
  request: string,
  ...rest: unknown[]
): unknown {
  if (request === "server-only") return {};
  return loadModule.call(this, request, ...rest);
};

const cwd = process.cwd();

for (const file of [".env", ".env.local"]) {
  const path = join(cwd, file);
  if (existsSync(path)) {
    loadDotenv({ path, override: file === ".env.local" });
  }
}
