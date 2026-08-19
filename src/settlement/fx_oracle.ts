/**
 * FX Oracle — TWAP aggregation over a netting period.
 *
 * Aggregates liquidity-pool price samples for each supported currency pair
 * over the netting period window and returns the Time-Weighted Average Price
 * (TWAP). Results are cached per period key so that multiple callers within
 * the same netting run share a single rate set.
 */

import { CurrencyPair, NETTING_INVARIANTS } from './netting_engine';

export interface PriceSample {
  /** UTC timestamp of the sample. */
  timestamp: Date;
  pair: CurrencyPair;
  /** Spot price at sample time (units of quote currency per base currency). */
  price: number;
}

export interface TwapResult {
  pair: CurrencyPair;
  twap: number;
  /** Number of samples used to compute the TWAP. */
  sampleCount: number;
  periodStart: Date;
  periodEnd: Date;
}

export type TwapRateMap = Partial<Record<CurrencyPair, number>>;

export interface LiquidityPoolAdapter {
  /**
   * Fetch all price samples for a currency pair within the given window.
   * Implementations may call on-chain oracles, CEX APIs, or in-memory stores.
   */
  getSamples(pair: CurrencyPair, from: Date, to: Date): Promise<PriceSample[]>;
}

/** Cache entry stored per period key. */
interface CacheEntry {
  rates: TwapRateMap;
  computedAt: Date;
}

/**
 * FxOracle computes and caches TWAP rates from a liquidity-pool adapter for
 * each supported currency pair over the netting period.
 *
 * Caching invariant: one cache entry per `${periodStart.toISOString()}` key.
 * The cache is intentionally in-memory; for a distributed system the cache
 * should be backed by Redis (handled at the infrastructure layer).
 */
export class FxOracle {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly pool: LiquidityPoolAdapter) {}

  /**
   * Returns TWAP rates for all supported pairs over the given netting period.
   * Subsequent calls for the same period key are served from cache.
   */
  async getRatesForPeriod(periodStart: Date, periodEnd: Date): Promise<TwapRateMap> {
    const key = periodStart.toISOString();

    if (this.cache.has(key)) {
      return this.cache.get(key)!.rates;
    }

    const rates: TwapRateMap = {};

    for (const pair of NETTING_INVARIANTS.currencyPairs) {
      const result = await this.computeTwap(pair, periodStart, periodEnd);
      if (result !== null) {
        rates[pair] = result.twap;
      }
    }

    this.cache.set(key, { rates, computedAt: new Date() });
    return rates;
  }

  /**
   * Computes the TWAP for a single pair over a time window.
   *
   * If no samples are available, returns null (callers should fall back to
   * a stale rate or reject the settlement with a missing-rate error).
   *
   * TWAP = Σ(price_i * duration_i) / total_duration
   * where duration_i is the time between consecutive samples.
   */
  async computeTwap(
    pair: CurrencyPair,
    from: Date,
    to: Date,
  ): Promise<TwapResult | null> {
    const samples = await this.pool.getSamples(pair, from, to);

    if (samples.length === 0) return null;

    // Sort ascending by timestamp
    const sorted = [...samples].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    if (sorted.length === 1) {
      // Only one sample: use it as-is (no time weighting possible)
      return {
        pair,
        twap: sorted[0].price,
        sampleCount: 1,
        periodStart: from,
        periodEnd: to,
      };
    }

    const windowMs = to.getTime() - from.getTime();
    if (windowMs <= 0) {
      throw new Error(`Invalid TWAP window: from=${from.toISOString()} to=${to.toISOString()}`);
    }

    let weightedSum = 0;
    let totalWeight = 0;

    for (let i = 0; i < sorted.length - 1; i++) {
      const duration = sorted[i + 1].timestamp.getTime() - sorted[i].timestamp.getTime();
      weightedSum += sorted[i].price * duration;
      totalWeight += duration;
    }

    // Include the last sample holding until `to`
    const lastDuration = to.getTime() - sorted[sorted.length - 1].timestamp.getTime();
    if (lastDuration > 0) {
      weightedSum += sorted[sorted.length - 1].price * lastDuration;
      totalWeight += lastDuration;
    }

    const twap = totalWeight > 0 ? weightedSum / totalWeight : sorted[sorted.length - 1].price;

    return {
      pair,
      twap,
      sampleCount: sorted.length,
      periodStart: from,
      periodEnd: to,
    };
  }

  /**
   * Invalidates the cached rates for a given period. Useful when a stale
   * entry needs to be refreshed (e.g. after an oracle error is corrected).
   */
  invalidate(periodStart: Date): void {
    this.cache.delete(periodStart.toISOString());
  }

  /** Returns the number of cached period entries (for observability). */
  get cacheSize(): number {
    return this.cache.size;
  }
}
