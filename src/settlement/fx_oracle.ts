export type Currency = 'USD' | 'EUR' | 'NGN' | 'KES';
export type CurrencyPair = 'USD/EUR' | 'USD/NGN' | 'USD/KES' | 'EUR/NGN' | 'EUR/KES';

export interface LiquidityPoolSample {
  pair: CurrencyPair;
  timestamp: Date;
  rate: number;
  liquidity: number;
}

export interface NettingPeriod {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

export interface FxRateProvider {
  loadSamples(pair: CurrencyPair, period: NettingPeriod): Promise<LiquidityPoolSample[]>;
}

export class InMemoryFxRateProvider implements FxRateProvider {
  constructor(private readonly samples: LiquidityPoolSample[] = []) {}

  addSample(sample: LiquidityPoolSample): void {
    this.samples.push(sample);
  }

  async loadSamples(pair: CurrencyPair, period: NettingPeriod): Promise<LiquidityPoolSample[]> {
    return this.samples.filter(
      (sample) =>
        sample.pair === pair &&
        sample.timestamp >= period.startsAt &&
        sample.timestamp <= period.endsAt,
    );
  }
}

export class FxOracle {
  private readonly cache = new Map<string, number>();

  constructor(private readonly provider: FxRateProvider) {}

  async twap(pair: CurrencyPair, period: NettingPeriod): Promise<number> {
    const key = `${period.id}:${pair}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const samples = (await this.provider.loadSamples(pair, period))
      .filter((sample) => Number.isFinite(sample.rate) && sample.rate > 0)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    if (samples.length === 0) throw new Error(`No FX samples for ${pair} during ${period.id}`);

    const start = period.startsAt.getTime();
    const end = period.endsAt.getTime();
    if (end <= start) throw new Error('Netting period end must be after start');

    let weightedRate = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const segmentStart = Math.max(samples[i].timestamp.getTime(), start);
      const segmentEnd = i + 1 < samples.length ? Math.min(samples[i + 1].timestamp.getTime(), end) : end;
      const duration = Math.max(0, segmentEnd - segmentStart);
      weightedRate += samples[i].rate * duration;
    }

    const twap = weightedRate / (end - start);
    this.cache.set(key, twap);
    return twap;
  }

  clearPeriod(periodId: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${periodId}:`)) this.cache.delete(key);
  }
}
