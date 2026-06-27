import { Gauge } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';
import {
  RATE_LIMIT_ADAPTIVE_CEILING,
  RATE_LIMIT_ADAPTIVE_FLOOR,
  RATE_LIMIT_DEFAULT_MAX,
} from '../config/rate-limits';
import { SorobanRpcService, SorobanTelemetry } from '../services/soroban-rpc';

const currentMaxGauge = new Gauge({
  name: 'rate_limit_current_max',
  help: 'Current adaptive maximum requests per sliding window',
  labelNames: ['scope'] as const,
  registers: [metricsRegistry],
});

export class AdaptiveController {
  private currentMax = RATE_LIMIT_DEFAULT_MAX;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly rpcService: Pick<SorobanRpcService, 'getTelemetry'>,
    private readonly pollIntervalMs: number = 10_000,
    private readonly scope: string = 'certificate_issuance',
  ) {
    currentMaxGauge.set({ scope: this.scope }, this.currentMax);
  }

  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  sample(): number {
    this.currentMax = AdaptiveController.calculateMaxRate(this.rpcService.getTelemetry());
    currentMaxGauge.set({ scope: this.scope }, this.currentMax);
    return this.currentMax;
  }

  getCurrentMax(): number {
    return this.currentMax;
  }

  static calculateMaxRate(telemetry: SorobanTelemetry): number {
    const latencyScore = this.degradationScore(telemetry.p99LatencyMs, 200, 2_000);
    const gasScore = this.degradationScore(telemetry.gasPriceXlm, 0.001, 0.01);
    const degradation = Math.max(latencyScore, gasScore);
    const max = RATE_LIMIT_ADAPTIVE_CEILING - degradation * (RATE_LIMIT_ADAPTIVE_CEILING - RATE_LIMIT_ADAPTIVE_FLOOR);
    return Math.round(this.clamp(max, RATE_LIMIT_ADAPTIVE_FLOOR, RATE_LIMIT_ADAPTIVE_CEILING));
  }

  private static degradationScore(value: number, healthy: number, degraded: number): number {
    if (value <= healthy) return 0;
    if (value >= degraded) return 1;
    return (value - healthy) / (degraded - healthy);
  }

  private static clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }
}
