/**
 * Math Helpers — Physical Measurement to Web3 Token Conversion
 *
 * Replaces all JavaScript Number-based arithmetic with FixedPoint calls to
 * eliminate rounding artifacts that accumulate across large transaction volumes.
 *
 * Background (issue #176):
 *   123.456 metric tons * 1e7 (Soroban 7-decimal precision) previously yielded
 *   1234560000.0000002 due to IEEE-754 f64 rounding. With FixedPoint all
 *   intermediate calculations use string-based integer math at 18 decimal places.
 *
 * All public functions accept and return decimal strings so callers never
 * touch raw Number arithmetic for value-sensitive operations.
 */

import {
  fromString,
  toString,
  toSorobanString,
  add,
  subtract,
  multiply,
  multiplyScaled,
  divide,
  compare,
  floor,
  roundHalfUp,
  zero,
  isZero,
  isNegative,
  rescale,
  INTERNAL_SCALE,
  SOROBAN_SCALE,
  MathError,
} from './fixed_point';
import type { FixedPoint } from './fixed_point';

// ─── Unit Conversion Constants ────────────────────────────────────────────────

/** Metric tons per short ton */
const METRIC_TON_TO_SHORT_TON = '0.90718474';
/** Metric tons per bushel (soybeans, ~60 lb/bu at 2204.62 lb/mt) */
const METRIC_TON_TO_BUSHEL_SOYBEAN = '36.74371';
/** Metric tons per bushel (wheat, ~60 lb/bu) */
const METRIC_TON_TO_BUSHEL_WHEAT = '36.74371';
/** Metric tons per bushel (corn, ~56 lb/bu) */
const METRIC_TON_TO_BUSHEL_CORN = '39.36817';
/** Liters per metric ton (water, density 1 kg/L at standard conditions) */
const LITERS_PER_METRIC_TON_WATER = '1000';

// ─── Core Token Conversion ────────────────────────────────────────────────────

/**
 * Convert a physical measurement (as a decimal string) to Soroban token units.
 *
 * Soroban uses 7 decimal places of precision. This function:
 *   1. Parses the input at INTERNAL_SCALE (18 dp) to avoid intermediate loss.
 *   2. Multiplies by 10^sorobanDecimals to get the scaled integer.
 *   3. Truncates to 7 decimal places for on-chain storage.
 *
 * @param amount        Physical measurement as decimal string (e.g. "123.456")
 * @param sorobanDecimals  Decimal precision of the target token (default 7)
 * @returns Decimal string representing the token unit count (e.g. "1234560000.0000000")
 *
 * @example
 *   toTokenUnits('123.456', 7) → '1234560000.0000000'
 *   // NOT the buggy: 123.456 * 1e7 = 1234560000.0000002
 */
export function toTokenUnits(amount: string, sorobanDecimals: number = SOROBAN_SCALE): string {
  const fp = fromString(amount, INTERNAL_SCALE);
  const factor = fromString('1' + '0'.repeat(sorobanDecimals), INTERNAL_SCALE);
  const product = multiplyScaled(fp, factor, INTERNAL_SCALE);
  return toSorobanString(product, sorobanDecimals);
}

/**
 * Convert Soroban token units back to a physical measurement string.
 *
 * @param tokenUnits    Token unit count as decimal string
 * @param sorobanDecimals  Decimal precision of the token (default 7)
 * @returns Physical measurement as decimal string
 */
export function fromTokenUnits(
  tokenUnits: string,
  sorobanDecimals: number = SOROBAN_SCALE,
): string {
  const fp = fromString(tokenUnits, INTERNAL_SCALE);
  const factor = fromString('1' + '0'.repeat(sorobanDecimals), INTERNAL_SCALE);
  const result = divide(fp, factor, INTERNAL_SCALE);
  return toString(result);
}

// ─── Commodity Unit Conversions ────────────────────────────────────────────────

/**
 * Convert metric tons to bushels of soybeans.
 * Uses the USDA standard: 1 metric ton = 36.74371 bushels (soybeans).
 */
export function metricTonsToBushelsSoybeans(metricTons: string): string {
  const fp = fromString(metricTons, INTERNAL_SCALE);
  const factor = fromString(METRIC_TON_TO_BUSHEL_SOYBEAN, INTERNAL_SCALE);
  return toString(multiplyScaled(fp, factor, INTERNAL_SCALE));
}

/**
 * Convert metric tons to bushels of wheat.
 */
export function metricTonsToWheatBushels(metricTons: string): string {
  const fp = fromString(metricTons, INTERNAL_SCALE);
  const factor = fromString(METRIC_TON_TO_BUSHEL_WHEAT, INTERNAL_SCALE);
  return toString(multiplyScaled(fp, factor, INTERNAL_SCALE));
}

/**
 * Convert metric tons to bushels of corn.
 */
export function metricTonsToCornBushels(metricTons: string): string {
  const fp = fromString(metricTons, INTERNAL_SCALE);
  const factor = fromString(METRIC_TON_TO_BUSHEL_CORN, INTERNAL_SCALE);
  return toString(multiplyScaled(fp, factor, INTERNAL_SCALE));
}

/**
 * Convert metric tons to liters (water equivalent at 1 kg/L).
 */
export function metricTonsToLiters(metricTons: string): string {
  const fp = fromString(metricTons, INTERNAL_SCALE);
  const factor = fromString(LITERS_PER_METRIC_TON_WATER, INTERNAL_SCALE);
  return toString(multiplyScaled(fp, factor, INTERNAL_SCALE));
}

// ─── Aggregation Helpers ──────────────────────────────────────────────────────

/**
 * Sum an array of decimal strings without any floating-point rounding.
 *
 * @param values  Array of decimal strings (may be empty → returns "0")
 * @returns Exact sum as decimal string
 */
export function sumDecimals(values: readonly string[]): string {
  let acc = zero(INTERNAL_SCALE);
  for (const v of values) {
    acc = add(acc, fromString(v, INTERNAL_SCALE));
  }
  return toString(acc);
}

/**
 * Compute the weighted average of (value, weight) pairs.
 * Returns "0" if the total weight is zero.
 *
 * @param pairs  Array of [value, weight] decimal string tuples
 * @returns Weighted average as decimal string at INTERNAL_SCALE precision
 */
export function weightedAverage(pairs: ReadonlyArray<readonly [string, string]>): string {
  let sumValues = zero(INTERNAL_SCALE);
  let sumWeights = zero(INTERNAL_SCALE);

  for (const [value, weight] of pairs) {
    const fpValue = fromString(value, INTERNAL_SCALE);
    const fpWeight = fromString(weight, INTERNAL_SCALE);
    sumValues = add(sumValues, multiplyScaled(fpValue, fpWeight, INTERNAL_SCALE));
    sumWeights = add(sumWeights, fpWeight);
  }

  if (isZero(sumWeights)) return '0';
  return toString(divide(sumValues, sumWeights, INTERNAL_SCALE));
}

// ─── Balance / Inventory Reconciliation ──────────────────────────────────────

/**
 * Verify that the sum of individual fractional token holdings does not
 * diverge from the physical inventory total by more than a tolerance.
 *
 * @param physicalTotal  Physical inventory total (decimal string)
 * @param holdings       Array of individual token holding amounts (decimal strings)
 * @param tolerance      Maximum allowed absolute divergence (decimal string, default "0.0000001")
 * @returns true if sum(holdings) is within tolerance of physicalTotal
 */
export function reconcileInventory(
  physicalTotal: string,
  holdings: readonly string[],
  tolerance = '0.0000001',
): boolean {
  const total = fromString(physicalTotal, INTERNAL_SCALE);
  const sumHoldings = fromString(sumDecimals(holdings), INTERNAL_SCALE);
  const fpTolerance = fromString(tolerance, INTERNAL_SCALE);

  const diff = subtract(total, sumHoldings);
  // Use absolute value for comparison
  const absDiff: FixedPoint = {
    value: diff.value.startsWith('-') ? diff.value.slice(1) : diff.value,
    scale: diff.scale,
  };

  return compare(absDiff, fpTolerance) <= 0;
}

// ─── Truncation / Rounding Exports ───────────────────────────────────────────

/**
 * Truncate a decimal string to `targetScale` decimal places (floor toward zero).
 */
export function truncate(value: string, targetScale: number = SOROBAN_SCALE): string {
  const fp = fromString(value, INTERNAL_SCALE);
  return toString(floor(fp, targetScale));
}

/**
 * Round a decimal string to `targetScale` decimal places using round-half-up.
 */
export function round(value: string, targetScale: number = SOROBAN_SCALE): string {
  const fp = fromString(value, INTERNAL_SCALE);
  return toString(roundHalfUp(fp, targetScale));
}

// ─── Re-exports for callers that want raw FixedPoint arithmetic ───────────────

export {
  fromString,
  toString,
  toSorobanString,
  add,
  subtract,
  multiply,
  multiplyScaled,
  divide,
  compare,
  floor,
  roundHalfUp,
  zero,
  isZero,
  isNegative,
  rescale,
  INTERNAL_SCALE,
  SOROBAN_SCALE,
  MathError,
};

export type { FixedPoint };
