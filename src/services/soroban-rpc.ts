import { SorobanRpcClient, SorobanRpcConfig, RawSimulationResult } from '../blockchain/soroban_bridge';

export interface SorobanTelemetry {
  p99LatencyMs: number;
  gasPriceXlm: number;
}

export class SorobanRpcService {
  private readonly client: SorobanRpcClient;
  private readonly latencySamples: number[] = [];
  private gasPriceXlm = 0.001;
  private readonly maxSamples: number;

  constructor(config: SorobanRpcConfig, maxSamples: number = 512) {
    this.client = new SorobanRpcClient(config);
    this.maxSamples = maxSamples;
  }

  async simulateTransaction(transactionXdr: string): Promise<RawSimulationResult> {
    const start = performance.now();
    try {
      const result = await this.client.simulateTransaction(transactionXdr);
      this.recordGasFromFee(result.minResourceFee);
      return result;
    } finally {
      this.recordLatency(performance.now() - start);
    }
  }

  recordLatency(latencyMs: number): void {
    this.latencySamples.push(latencyMs);
    if (this.latencySamples.length > this.maxSamples) {
      this.latencySamples.splice(0, this.latencySamples.length - this.maxSamples);
    }
  }

  recordGasPrice(gasPriceXlm: number): void {
    if (Number.isFinite(gasPriceXlm) && gasPriceXlm >= 0) {
      this.gasPriceXlm = gasPriceXlm;
    }
  }

  getTelemetry(): SorobanTelemetry {
    return {
      p99LatencyMs: this.percentile(0.99),
      gasPriceXlm: this.gasPriceXlm,
    };
  }

  private recordGasFromFee(minResourceFeeStroops: number): void {
    if (Number.isFinite(minResourceFeeStroops) && minResourceFeeStroops >= 0) {
      this.gasPriceXlm = minResourceFeeStroops / 10_000_000;
    }
  }

  private percentile(percentile: number): number {
    if (this.latencySamples.length === 0) return 0;
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1);
    return sorted[index];
  }
}
