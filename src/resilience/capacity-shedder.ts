import type { NextFunction, Request, Response } from 'express';
import { totalmem } from 'os';
import { Counter, Gauge } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';
import { featureFlags, FeatureFlagRegistry } from './feature-flags';

export type RequestPriority = 'critical' | 'important' | 'background';

export interface CapacitySignal {
  inflight: number;
  eventLoopLagMs: number;
  cpuUtilization: number;
  memoryUtilization: number;
}

export interface CapacityShedderOptions {
  maxInflight: number;
  maxEventLoopLagMs: number;
  maxCpuUtilization: number;
  maxMemoryUtilization: number;
  shedBackgroundAt: number;
  shedImportantAt: number;
}

export interface CapacityDecision {
  allowed: boolean;
  degraded: boolean;
  priority: RequestPriority;
  score: number;
  reason: string;
  retryAfterSeconds?: number;
}

const DEFAULT_OPTIONS: CapacityShedderOptions = {
  maxInflight: Number(process.env.CAPACITY_MAX_INFLIGHT ?? 500),
  maxEventLoopLagMs: Number(process.env.CAPACITY_MAX_EVENT_LOOP_LAG_MS ?? 100),
  maxCpuUtilization: Number(process.env.CAPACITY_MAX_CPU_UTILIZATION ?? 0.85),
  maxMemoryUtilization: Number(process.env.CAPACITY_MAX_MEMORY_UTILIZATION ?? 0.9),
  shedBackgroundAt: Number(process.env.CAPACITY_SHED_BACKGROUND_AT ?? 0.7),
  shedImportantAt: Number(process.env.CAPACITY_SHED_IMPORTANT_AT ?? 0.9),
};

const degradedResponsesTotal = new Counter({
  name: 'resilience_degraded_responses_total',
  help: 'Requests served with degraded behavior instead of full functionality',
  labelNames: ['priority', 'reason'] as const,
  registers: [metricsRegistry],
});

const shedRequestsTotal = new Counter({
  name: 'resilience_shed_requests_total',
  help: 'Requests rejected by the capacity shedder',
  labelNames: ['priority', 'reason'] as const,
  registers: [metricsRegistry],
});

const capacityScoreGauge = new Gauge({
  name: 'resilience_capacity_score',
  help: 'Capacity pressure score from 0 healthy to 1 saturated',
  registers: [metricsRegistry],
});

export class CapacityShedder {
  private inflight = 0;
  private eventLoopLagMs = 0;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuAt = process.hrtime.bigint();
  private lagTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: CapacityShedderOptions = DEFAULT_OPTIONS) {}

  start(): void {
    if (this.lagTimer) return;
    let expected = Date.now() + 1000;
    this.lagTimer = setInterval(() => {
      const now = Date.now();
      this.eventLoopLagMs = Math.max(0, now - expected);
      expected = now + 1000;
    }, 1000);
    this.lagTimer.unref();
  }

  stop(): void {
    if (!this.lagTimer) return;
    clearInterval(this.lagTimer);
    this.lagTimer = null;
  }

  enter(): void {
    this.inflight += 1;
  }

  leave(): void {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  decide(
    priority: RequestPriority,
    signal: CapacitySignal = this.currentSignal(),
  ): CapacityDecision {
    const score = this.score(signal);
    capacityScoreGauge.set(score);

    if (priority === 'critical') {
      return {
        allowed: true,
        degraded: score >= this.options.shedBackgroundAt,
        priority,
        score,
        reason: 'critical-path-protected',
      };
    }
    if (priority === 'important' && score >= this.options.shedImportantAt) {
      return {
        allowed: false,
        degraded: false,
        priority,
        score,
        reason: 'important-capacity-shed',
        retryAfterSeconds: 10,
      };
    }
    if (priority === 'background' && score >= this.options.shedBackgroundAt) {
      return {
        allowed: false,
        degraded: false,
        priority,
        score,
        reason: 'background-capacity-shed',
        retryAfterSeconds: 30,
      };
    }
    return {
      allowed: true,
      degraded: score >= this.options.shedBackgroundAt,
      priority,
      score,
      reason: 'within-capacity',
    };
  }

  currentSignal(): CapacitySignal {
    return {
      inflight: this.inflight,
      eventLoopLagMs: this.eventLoopLagMs,
      cpuUtilization: this.cpuUtilization(),
      memoryUtilization: process.memoryUsage().rss / Math.max(1, totalmem()),
    };
  }

  private score(signal: CapacitySignal): number {
    return Math.max(
      ratio(signal.inflight, this.options.maxInflight),
      ratio(signal.eventLoopLagMs, this.options.maxEventLoopLagMs),
      ratio(signal.cpuUtilization, this.options.maxCpuUtilization),
      ratio(signal.memoryUtilization, this.options.maxMemoryUtilization),
    );
  }

  private cpuUtilization(): number {
    const now = process.hrtime.bigint();
    const usage = process.cpuUsage(this.lastCpuUsage);
    const elapsedMicros = Number(now - this.lastCpuAt) / 1000;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuAt = now;
    return Math.min(1, (usage.user + usage.system) / Math.max(1, elapsedMicros));
  }
}

export const capacityShedder = new CapacityShedder();

export function createCapacitySheddingMiddleware(
  shedder: CapacityShedder = capacityShedder,
  flags: FeatureFlagRegistry = featureFlags,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    shedder.enter();
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      shedder.leave();
    };
    res.once('finish', leave);
    res.once('close', leave);

    const priority = classifyRequest(req);
    const decision = shedder.decide(priority);
    res.setHeader('X-Capacity-Score', decision.score.toFixed(3));

    if (!decision.allowed) {
      shedRequestsTotal.inc({ priority, reason: decision.reason });
      res.setHeader('Retry-After', String(decision.retryAfterSeconds ?? 10));
      res.status(503).json({
        error: 'capacity_shed',
        reason: decision.reason,
        retryAfterSeconds: decision.retryAfterSeconds,
      });
      return;
    }

    const nonCriticalFlag = flagForRequest(req);
    if (nonCriticalFlag && !flags.evaluate(nonCriticalFlag).enabled) {
      degradedResponsesTotal.inc({ priority, reason: `${nonCriticalFlag}-disabled` });
      res.locals.degraded = true;
      res.setHeader('X-Degraded-Mode', nonCriticalFlag);
    } else if (decision.degraded) {
      degradedResponsesTotal.inc({ priority, reason: decision.reason });
      res.locals.degraded = true;
      res.setHeader('X-Degraded-Mode', decision.reason);
    }

    next();
  };
}

export function classifyRequest(req: Pick<Request, 'method' | 'path'>): RequestPriority {
  if (req.path.startsWith('/health') || req.path.startsWith('/metrics')) return 'critical';
  if (req.method === 'GET') return 'important';
  if (req.path.includes('/webhooks') || req.path.includes('/admin/jobs')) return 'background';
  return 'important';
}

function flagForRequest(req: Pick<Request, 'path'>): string | undefined {
  if (req.path.includes('/webhooks')) return 'webhook.delivery';
  if (req.path.includes('/telemetry')) return 'telemetry.enrichment';
  return undefined;
}

function ratio(value: number, max: number): number {
  if (max <= 0) return 1;
  return Math.max(0, Math.min(1, value / max));
}
