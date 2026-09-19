export const DEFAULT_INVOCATION_MAX_WALLETS = 10;
export const DEFAULT_INVOCATION_MAX_RUNTIME_MS = 2 * 60 * 60 * 1000;

export function resolveInvocationMaxWallets(
  override?: number
): number | null {
  if (override != null && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const raw = process.env.STAGE_C_INVOCATION_MAX_WALLETS?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

export function resolveInvocationMaxRuntimeMs(
  override?: number
): number | null {
  if (override != null && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const raw = process.env.STAGE_C_INVOCATION_MAX_RUNTIME_MS?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

export type InvocationBudgetExhaustReason =
  | "invocation_wallet_budget_exhausted"
  | "invocation_runtime_budget_exhausted";

export class InvocationBudget {
  readonly startedAt = Date.now();
  private walletsScheduled = 0;

  constructor(
    readonly maxWallets: number | null,
    readonly maxRuntimeMs: number | null
  ) {}

  get walletsStarted(): number {
    return this.walletsScheduled;
  }

  canScheduleNextWallet(): boolean {
    if (this.maxWallets != null && this.walletsScheduled >= this.maxWallets) {
      return false;
    }
    if (
      this.maxRuntimeMs != null &&
      Date.now() - this.startedAt >= this.maxRuntimeMs
    ) {
      return false;
    }
    return true;
  }

  markWalletScheduled(): void {
    this.walletsScheduled += 1;
  }

  exhaustedReason(): InvocationBudgetExhaustReason | null {
    if (this.maxWallets != null && this.walletsScheduled >= this.maxWallets) {
      return "invocation_wallet_budget_exhausted";
    }
    if (
      this.maxRuntimeMs != null &&
      Date.now() - this.startedAt >= this.maxRuntimeMs
    ) {
      return "invocation_runtime_budget_exhausted";
    }
    return null;
  }

  snapshot(): {
    startedAt: string;
    walletsScheduled: number;
    maxWallets: number | null;
    maxRuntimeMs: number | null;
    elapsedMs: number;
    exhaustedReason: InvocationBudgetExhaustReason | null;
  } {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      walletsScheduled: this.walletsScheduled,
      maxWallets: this.maxWallets,
      maxRuntimeMs: this.maxRuntimeMs,
      elapsedMs: Date.now() - this.startedAt,
      exhaustedReason: this.exhaustedReason(),
    };
  }
}
