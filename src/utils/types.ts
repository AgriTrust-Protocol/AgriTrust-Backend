/**
 * Fixed-Point Decimal Type Definitions
 *
 * Provides the core types used by the arbitrary-precision decimal math engine.
 * All arithmetic operates on string-based representations to avoid f64/Number
 * rounding artifacts when converting physical measurements to Web3 token units.
 *
 * Related to issue #176 — Fixed-Point Decimal Math Engine.
 */

/**
 * A signed decimal number stored as a scaled integer string.
 *
 * @example
 *   // 1.23456 with scale=18 → value = "1234560000000000000"
 *   const fp: FixedPoint = { value: '1234560000000000000', scale: 18 };
 */
export interface FixedPoint {
  /**
   * The scaled integer value as a decimal string (no decimal point).
   * May be prefixed with '-' for negative values.
   * Represents the real number: Number(value) / 10^scale
   */
  value: string;
  /**
   * Number of decimal places the value string is scaled by.
   * Minimum: 0   Maximum: 38
   */
  scale: number;
}

/**
 * A 128-bit fixed-point decimal with exactly 18 decimal places of precision.
 * Fits within a signed 128-bit integer (i128) range:
 *   max ≈ 1.701411834604692317 × 10^20 (at scale=18)
 *
 * Used for Soroban/Stellar token arithmetic where balances must be exact.
 */
export interface Decimal128 {
  /** The scaled integer string at scale=18 */
  value: string;
  /** Always 18 for Decimal128 */
  readonly scale: 18;
}

/**
 * Error class for all fixed-point arithmetic failures.
 */
export class MathError extends Error {
  constructor(
    message: string,
    public readonly code: MathErrorCode,
  ) {
    super(message);
    this.name = 'MathError';
  }
}

export type MathErrorCode =
  | 'INVALID_INPUT'
  | 'DIVISION_BY_ZERO'
  | 'OVERFLOW'
  | 'UNDERFLOW'
  | 'SCALE_MISMATCH'
  | 'PRECISION_LOSS';

/** Maximum scale supported internally (18 decimal places) */
export const INTERNAL_SCALE = 18 as const;

/** Output scale for Soroban compatibility (7 decimal places) */
export const SOROBAN_SCALE = 7 as const;

/**
 * The i128 maximum value as a string.
 * 2^127 - 1 = 170141183460469231731687303715884105727
 */
export const I128_MAX = '170141183460469231731687303715884105727' as const;

/**
 * The i128 minimum value as a string (absolute value).
 * 2^127     = 170141183460469231731687303715884105728
 */
export const I128_MIN_ABS = '170141183460469231731687303715884105728' as const;
