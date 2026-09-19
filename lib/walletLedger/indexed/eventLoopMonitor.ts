import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { auditLog } from "@/lib/walletLedger/indexed/auditProgress";

export interface EventLoopDelaySnapshot {
  eventLoopDelayP95Ms: number;
  eventLoopDelayMaxMs: number;
  enabled: boolean;
}

let activeMonitor: EventLoopDelayMonitor | null = null;

export function startEventLoopDelayMonitor(): EventLoopDelayMonitor {
  const monitor = new EventLoopDelayMonitor();
  monitor.start();
  activeMonitor = monitor;
  return monitor;
}

export function stopEventLoopDelayMonitor(): EventLoopDelaySnapshot {
  if (!activeMonitor) {
    return {
      eventLoopDelayP95Ms: 0,
      eventLoopDelayMaxMs: 0,
      enabled: false,
    };
  }
  const snapshot = activeMonitor.snapshot();
  activeMonitor.stop();
  activeMonitor = null;
  return snapshot;
}

export function getActiveEventLoopDelayMonitor(): EventLoopDelayMonitor | null {
  return activeMonitor;
}

export class EventLoopDelayMonitor {
  private readonly histogram: IntervalHistogram;
  private enabled = false;

  constructor(resolutionMs = 20) {
    this.histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  }

  start(): void {
    if (this.enabled) return;
    this.histogram.enable();
    this.enabled = true;
  }

  stop(): void {
    if (!this.enabled) return;
    this.histogram.disable();
    this.enabled = false;
  }

  reset(): void {
    this.histogram.reset();
  }

  snapshot(): EventLoopDelaySnapshot {
    return {
      eventLoopDelayP95Ms: Math.round(this.histogram.percentile(95) / 1e6),
      eventLoopDelayMaxMs: Math.round(this.histogram.max / 1e6),
      enabled: this.enabled,
    };
  }

  logSnapshot(label: string): EventLoopDelaySnapshot {
    const snap = this.snapshot();
    auditLog(
      `[event-loop-delay] label=${label} p95Ms=${snap.eventLoopDelayP95Ms} maxMs=${snap.eventLoopDelayMaxMs}`
    );
    return snap;
  }
}
