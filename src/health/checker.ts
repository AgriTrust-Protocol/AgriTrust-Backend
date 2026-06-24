import { setTimeout as delay } from 'timers/promises';

export type HealthCheckType = 'liveness' | 'readiness' | 'depth';
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthCheckResult {
  service: string;
  type: HealthCheckType;
  status: HealthStatus;
  latency: number;
  error?: string;
  timestamp: number;
}

export type HealthCheckProbe = (
  service: string,
  type: HealthCheckType,
  signal: AbortSignal,
) => Promise<{ status: HealthStatus; error?: string }>;

export class HealthChecker {
  static readonly intervalsSeconds: Record<HealthCheckType, number> = {
    liveness: 10,
    readiness: 30,
    depth: 60,
  };

  static readonly timeoutsMs: Record<HealthCheckType, number> = {
    liveness: 5_000,
    readiness: 10_000,
    depth: 30_000,
  };

  private readonly probe: HealthCheckProbe;
  private readonly timeouts: Record<HealthCheckType, number>;

  constructor(
    probe?: HealthCheckProbe,
    timeouts: Partial<Record<HealthCheckType, number>> = {},
  ) {
    this.probe = probe ?? this.defaultProbe.bind(this);
    this.timeouts = { ...HealthChecker.timeoutsMs, ...timeouts };
  }

  async checkService(service: string, type: HealthCheckType): Promise<HealthCheckResult> {
    const startedAt = Date.now();
    const abortController = new AbortController();
    const timeoutMs = this.timeouts[type];

    try {
      const timeout = delay(timeoutMs, undefined, { signal: abortController.signal }).then(() => {
        throw new Error(`${type} check timed out after ${timeoutMs}ms`);
      });
      const result = await Promise.race([
        this.probe(service, type, abortController.signal),
        timeout,
      ]);

      return {
        service,
        type,
        status: result.status,
        latency: Date.now() - startedAt,
        error: result.error,
        timestamp: Date.now(),
      };
    } catch (err: unknown) {
      return {
        service,
        type,
        status: 'unhealthy',
        latency: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
    } finally {
      abortController.abort();
    }
  }

  async checkAll(service: string): Promise<HealthCheckResult[]> {
    return Promise.all([
      this.checkService(service, 'liveness'),
      this.checkService(service, 'readiness'),
      this.checkService(service, 'depth'),
    ]);
  }

  private async defaultProbe(
    service: string,
    type: HealthCheckType,
  ): Promise<{ status: HealthStatus; error?: string }> {
    await delay(Math.random() * 100);
    const failureRates: Record<HealthCheckType, number> = {
      liveness: 0.02,
      readiness: 0.05,
      depth: 0.1,
    };
    const draw = Math.random();
    const failureRate = failureRates[type];

    if (draw < failureRate * 0.5) {
      return { status: 'degraded', error: `${type} check degraded for ${service}` };
    }
    if (draw < failureRate) {
      return { status: 'unhealthy', error: `${type} check failed for ${service}` };
    }
    return { status: 'healthy' };
  }
}
