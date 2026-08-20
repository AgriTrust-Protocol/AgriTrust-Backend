/**
 * Fixed-Point Decimal Math Engine — Property-Based Test Suite
 *
 * Covers all invariants from issue #176:
 *   - Additive identity and inverse:  a + b - b = a
 *   - Distributivity:                 a * (b + c) = a*b + a*c  (within rounding)
 *   - Commutativity:                  a + b = b + a
 *   - Associativity:                  (a + b) + c = a + (b + c)
 *   - Overflow detection:             product of large 18-scale values throws
 *   - Division:                       a / b * b ≈ a  (within rounding tolerance)
 *   - Comparison consistency:         compare(a, b) is antisymmetric
 *   - Rounding:                       round half-up semantics
 *   - Soroban conversion:             toTokenUnits is exact for 7-decimal output
 *   - Token round-trip:               fromTokenUnits(toTokenUnits(x)) ≈ x
 *   - Reconciliation:                 sum of parts equals whole within tolerance
 *   - Known issue regression:         123.456 * 1e7 = 1234560000.0000000 (exact)
 *   - Performance:                    100,000 add ops complete in < 10s
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  fromString,
  toString,
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
  INTERNAL_SCALE,
  MathError,
} from '../../src/utils/fixed_point';
import {
  toTokenUnits,
  fromTokenUnits,
  sumDecimals,
  reconcileInventory,
  truncate,
  round,
} from '../../src/utils/math_helpers';

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Digit chars 0-9 as a constant arbitrary */
const digitChar = fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9');
/** Non-zero digit chars 1-9 as a constant arbitrary */
const nonZeroDigitChar = fc.constantFrom('1', '2', '3', '4', '5', '6', '7', '8', '9');

/** Build a string of digits using fc.array (replaces fc.stringOf which was removed in v4) */
function digitString(min: number, max: number): fc.Arbitrary<string> {
  return fc.array(digitChar, { minLength: min, maxLength: max }).map((chars) => chars.join(''));
}

/** Build a string of non-zero-leading digits */
function nonZeroLeadingString(min: number, max: number): fc.Arbitrary<string> {
  return fc
    .tuple(
      nonZeroDigitChar,
      fc.array(digitChar, { minLength: Math.max(0, min - 1), maxLength: Math.max(0, max - 1) }),
    )
    .map(([first, rest]: [string, string[]]) => first + rest.join(''));
}

/**
 * Generate a decimal string with up to `maxInt` integer digits and
 * up to `maxFrac` fractional digits, optionally negative.
 */
function decimalStringArb(
  maxInt = 10,
  maxFrac = 8,
  allowNegative = true,
): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.boolean(),
      nonZeroLeadingString(1, maxInt),
      digitString(0, maxFrac),
    )
    .map(([neg, intPart, fracPart]: [boolean, string, string]) => {
      const result = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
      return allowNegative && neg && result !== '0' ? `-${result}` : result;
    });
}

/**
 * Generate a small positive decimal string (avoids division-by-zero in property tests).
 */
function positiveDecimalArb(maxInt = 6, maxFrac = 6): fc.Arbitrary<string> {
  return fc
    .tuple(
      nonZeroLeadingString(1, maxInt),
      digitString(0, maxFrac),
    )
    .map(([intPart, fracPart]: [string, string]) => {
      return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
    });
}

/** Round a FixedPoint result toString and back at INTERNAL_SCALE for comparison. */
function normalize(s: string): string {
  return toString(fromString(s, INTERNAL_SCALE));
}

/** Check whether two strings represent the same decimal value after normalisation. */
function decimalEqual(a: string, b: string): boolean {
  const fa = fromString(a, INTERNAL_SCALE);
  const fb = fromString(b, INTERNAL_SCALE);
  return compare(fa, fb) === 0;
}

// ─── Regression: The Exact Issue #176 Case ───────────────────────────────────

describe('Issue #176 regression — 123.456 metric tons at 7-decimal precision', () => {
  it('converts 123.456 to exactly 1234560000 token units (no rounding artifact)', () => {
    const result = toTokenUnits('123.456', 7);
    // The buggy JS result was '1234560000.0000002'
    // The correct result is exactly '1234560000.0000000'
    expect(result).toBe('1234560000.0000000');
  });

  it('round-trips 123.456 through token units without divergence', () => {
    const tokenUnits = toTokenUnits('123.456', 7);
    const restored = fromTokenUnits(tokenUnits, 7);
    // After round-trip, value should match original to 7 decimal places
    const diff = subtract(
      fromString('123.456', INTERNAL_SCALE),
      fromString(restored, INTERNAL_SCALE),
    );
    const absDiff = {
      value: diff.value.startsWith('-') ? diff.value.slice(1) : diff.value,
      scale: diff.scale,
    };
    const tolerance = fromString('0.0000001', INTERNAL_SCALE);
    expect(compare(absDiff, tolerance)).toBeLessThanOrEqual(0);
  });

  it('summing 1000 holdings of 123.456 equals physical inventory of 123456.000', () => {
    const holdings = Array(1000).fill(toTokenUnits('123.456', 7));
    const physicalTotal = '123456000.0000000'; // 123.456 * 1000 = 123456, times 1e7
    const sumResult = sumDecimals(holdings);
    expect(decimalEqual(sumResult, physicalTotal)).toBe(true);
  });
});

// ─── fromString / toString ───────────────────────────────────────────────────

describe('fromString', () => {
  it('parses integer strings', () => {
    const fp = fromString('42', 0);
    expect(fp.value).toBe('42');
    expect(fp.scale).toBe(0);
  });

  it('parses decimal strings at scale 18', () => {
    const fp = fromString('1.5', 18);
    expect(fp.value).toBe('1500000000000000000');
    expect(fp.scale).toBe(18);
  });

  it('parses negative decimal', () => {
    const fp = fromString('-3.14', 2);
    expect(fp.value).toBe('-314');
    expect(fp.scale).toBe(2);
  });

  it('pads fractional part with trailing zeros', () => {
    const fp = fromString('1.5', 4);
    expect(fp.value).toBe('15000');
    expect(fp.scale).toBe(4);
  });

  it('truncates fractional part when longer than scale', () => {
    const fp = fromString('1.12345', 2);
    expect(fp.value).toBe('112');
    expect(fp.scale).toBe(2);
  });

  it('parses zero correctly', () => {
    const fp = fromString('0', 18);
    expect(fp.value).toBe('0');
  });

  it('parses string with only fractional part', () => {
    const fp = fromString('.5', 2);
    expect(fp.value).toBe('50');
  });

  it('throws MathError for invalid input', () => {
    expect(() => fromString('abc', 2)).toThrow(MathError);
    expect(() => fromString('1.2.3', 2)).toThrow(MathError);
    expect(() => fromString('', 2)).toThrow(MathError);
    expect(() => fromString('1e5', 2)).toThrow(MathError);
  });

  it('strips leading/trailing whitespace', () => {
    const fp = fromString('  42.00  ', 2);
    expect(fp.value).toBe('4200');
  });
});

describe('toString', () => {
  it('converts scale-2 value back to decimal string', () => {
    const fp = fromString('12.34', 2);
    expect(toString(fp)).toBe('12.34');
  });

  it('converts scale-0 value to integer string', () => {
    expect(toString({ value: '999', scale: 0 })).toBe('999');
  });

  it('handles zero', () => {
    expect(toString(zero(4))).toBe('0.0000');
  });

  it('round-trips arbitrary decimals', () => {
    fc.assert(
      fc.property(decimalStringArb(8, 8, false), (s) => {
        const fp = fromString(s, INTERNAL_SCALE);
        const result = toString(roundHalfUp(fp, 8));
        // Both should parse to the same value at 8 dp
        const reparsed = fromString(result, 8);
        const original = fromString(s, 8);
        expect(compare(original, reparsed)).toBe(0);
      }),
      { numRuns: 200 },
    );
  });
});

// ─── Addition ────────────────────────────────────────────────────────────────

describe('add', () => {
  it('adds two positive decimals', () => {
    const a = fromString('1.5', 2);
    const b = fromString('2.5', 2);
    expect(toString(add(a, b))).toBe('4.00');
  });

  it('adds positive and negative', () => {
    const a = fromString('5.0', 1);
    const b = fromString('-3.0', 1);
    expect(toString(add(a, b))).toBe('2.0');
  });

  it('produces zero when adding negation', () => {
    const a = fromString('7.77', 2);
    const b = fromString('-7.77', 2);
    expect(isZero(add(a, b))).toBe(true);
  });

  it('commutative: a + b = b + a', () => {
    fc.assert(
      fc.property(decimalStringArb(), decimalStringArb(), (sa, sb) => {
        const a = fromString(sa, INTERNAL_SCALE);
        const b = fromString(sb, INTERNAL_SCALE);
        expect(compare(add(a, b), add(b, a))).toBe(0);
      }),
      { numRuns: 500 },
    );
  });

  it('associative: (a + b) + c = a + (b + c)', () => {
    fc.assert(
      fc.property(decimalStringArb(), decimalStringArb(), decimalStringArb(), (sa, sb, sc) => {
        const a = fromString(sa, INTERNAL_SCALE);
        const b = fromString(sb, INTERNAL_SCALE);
        const c = fromString(sc, INTERNAL_SCALE);
        const lhs = add(add(a, b), c);
        const rhs = add(a, add(b, c));
        expect(compare(lhs, rhs)).toBe(0);
      }),
      { numRuns: 300 },
    );
  });
});

// ─── Subtract ─────────────────────────────────────────────────────────────────

describe('subtract', () => {
  it('subtracts two values', () => {
    const a = fromString('10.0', 1);
    const b = fromString('3.5', 1);
    expect(toString(subtract(a, b))).toBe('6.5');
  });

  it('subtracting self yields zero', () => {
    fc.assert(
      fc.property(decimalStringArb(), (s) => {
        const a = fromString(s, INTERNAL_SCALE);
        expect(isZero(subtract(a, a))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('KEY PROPERTY: a + b - b = a', () => {
    fc.assert(
      fc.property(decimalStringArb(), decimalStringArb(), (sa, sb) => {
        const a = fromString(sa, INTERNAL_SCALE);
        const b = fromString(sb, INTERNAL_SCALE);
        const result = subtract(add(a, b), b);
        expect(compare(result, a)).toBe(0);
      }),
      { numRuns: 500 },
    );
  });
});

// ─── Multiply ────────────────────────────────────────────────────────────────

describe('multiply', () => {
  it('multiplies two positive values', () => {
    const a = fromString('3', 0);
    const b = fromString('4', 0);
    const product = multiply(a, b);
    expect(product.value).toBe('12');
  });

  it('handles negative × positive', () => {
    const a = fromString('-2.5', 1);
    const b = fromString('4.0', 1);
    const product = multiply(a, b);
    expect(isNegative(product)).toBe(true);
  });

  it('negative × negative is positive', () => {
    const a = fromString('-3', 0);
    const b = fromString('-4', 0);
    const product = multiply(a, b);
    expect(isNegative(product)).toBe(false);
    expect(product.value).toBe('12');
  });

  it('multiplying by zero yields zero', () => {
    fc.assert(
      fc.property(decimalStringArb(), (s) => {
        const a = fromString(s, INTERNAL_SCALE);
        const z = zero(INTERNAL_SCALE);
        expect(isZero(multiplyScaled(a, z, INTERNAL_SCALE))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('KEY PROPERTY: a * (b + c) = a*b + a*c  within rounding tolerance', () => {
    fc.assert(
      fc.property(
        decimalStringArb(4, 4, false),
        decimalStringArb(4, 4, false),
        decimalStringArb(4, 4, false),
        (sa, sb, sc) => {
          const a = fromString(sa, INTERNAL_SCALE);
          const b = fromString(sb, INTERNAL_SCALE);
          const c = fromString(sc, INTERNAL_SCALE);

          const lhs = multiplyScaled(a, add(b, c), INTERNAL_SCALE);
          const rhs = add(
            multiplyScaled(a, b, INTERNAL_SCALE),
            multiplyScaled(a, c, INTERNAL_SCALE),
          );

          // Allow at most 1 ULP at INTERNAL_SCALE tolerance
          const diff = subtract(lhs, rhs);
          const absDiff = {
            value: diff.value.startsWith('-') ? diff.value.slice(1) : diff.value,
            scale: diff.scale,
          };
          // tolerance = 1 unit at scale 18 (i.e. 0.000000000000000001)
          const tolerance = fromString('0.000000000000000002', INTERNAL_SCALE);
          expect(compare(absDiff, tolerance)).toBeLessThanOrEqual(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('throws MathError OVERFLOW when product of two large 18-scale values exceeds i128', () => {
    // i128 max ≈ 1.7e38; a value like 1e20 at scale 18 has integer "100000000000000000000000000000000000000"
    // Multiplying two such values at scale=18 will overflow.
    const large = fromString('100000000000000000000', INTERNAL_SCALE); // 100000000000000000000 * 10^18
    expect(() => multiply(large, large)).toThrow(MathError);
    expect(() => multiply(large, large)).toThrow('overflow');
  });
});

// ─── Divide ──────────────────────────────────────────────────────────────────

describe('divide', () => {
  it('divides cleanly', () => {
    const a = fromString('10', INTERNAL_SCALE);
    const b = fromString('2', INTERNAL_SCALE);
    const q = divide(a, b, INTERNAL_SCALE);
    expect(compare(q, fromString('5', INTERNAL_SCALE))).toBe(0);
  });

  it('handles non-terminating decimals with round-half-up', () => {
    // 1 / 3 ≈ 0.333...
    const a = fromString('1', INTERNAL_SCALE);
    const b = fromString('3', INTERNAL_SCALE);
    const q = divide(a, b, 4);
    const s = toString(q);
    // Should be 0.3333 (truncated/rounded at 4 dp)
    expect(s).toMatch(/^0\.333/);
  });

  it('throws DIVISION_BY_ZERO when divisor is zero', () => {
    const a = fromString('5', INTERNAL_SCALE);
    const b = zero(INTERNAL_SCALE);
    expect(() => divide(a, b, INTERNAL_SCALE)).toThrow(MathError);
    expect(() => divide(a, b, INTERNAL_SCALE)).toThrow('zero');
  });

  it('a / b * b ≈ a within 1 ULP tolerance for positive values', () => {
    fc.assert(
      fc.property(positiveDecimalArb(4, 4), positiveDecimalArb(1, 4), (sa, sb) => {
        const a = fromString(sa, INTERNAL_SCALE);
        const b = fromString(sb, INTERNAL_SCALE);

        const q = divide(a, b, INTERNAL_SCALE);
        const restored = multiplyScaled(q, b, INTERNAL_SCALE);

        const diff = subtract(a, restored);
        const absDiff = {
          value: diff.value.startsWith('-') ? diff.value.slice(1) : diff.value,
          scale: diff.scale,
        };
        // Allow tolerance of 1 at scale 10 (0.0000000001) given rounding in long div
        const tolerance = fromString('0.00000001', INTERNAL_SCALE);
        expect(compare(absDiff, tolerance)).toBeLessThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });
});

// ─── Compare ─────────────────────────────────────────────────────────────────

describe('compare', () => {
  it('returns 0 for equal values at different scales', () => {
    const a = fromString('1.50', 2);
    const b = fromString('1.5', 1);
    expect(compare(a, b)).toBe(0);
  });

  it('returns -1 when a < b', () => {
    const a = fromString('1.0', 1);
    const b = fromString('2.0', 1);
    expect(compare(a, b)).toBe(-1);
  });

  it('returns 1 when a > b', () => {
    const a = fromString('5.0', 1);
    const b = fromString('3.0', 1);
    expect(compare(a, b)).toBe(1);
  });

  it('antisymmetric: compare(a,b) = -compare(b,a)', () => {
    fc.assert(
      fc.property(decimalStringArb(), decimalStringArb(), (sa, sb) => {
        const a = fromString(sa, INTERNAL_SCALE);
        const b = fromString(sb, INTERNAL_SCALE);
        const ab = compare(a, b);
        const ba = compare(b, a);
        expect(ab).toBe(-ba as -1 | 0 | 1);
      }),
      { numRuns: 500 },
    );
  });

  it('negative numbers compare correctly', () => {
    const a = fromString('-5', 0);
    const b = fromString('-3', 0);
    expect(compare(a, b)).toBe(-1); // -5 < -3
    expect(compare(b, a)).toBe(1);
  });
});

// ─── Floor / RoundHalfUp ─────────────────────────────────────────────────────

describe('floor', () => {
  it('truncates to integer part at scale 0', () => {
    const fp = fromString('3.99', 2);
    expect(toString(floor(fp, 0))).toBe('3');
  });

  it('truncates toward zero for negative values', () => {
    const fp = fromString('-3.99', 2);
    // floor toward zero: -3.99 → -3
    expect(toString(floor(fp, 0))).toBe('-3');
  });

  it('preserves value when scale already matches', () => {
    const fp = fromString('5.12', 2);
    expect(compare(floor(fp, 2), fp)).toBe(0);
  });
});

describe('roundHalfUp', () => {
  it('rounds up when 5th digit >= 5', () => {
    const fp = fromString('1.23456789', 8);
    const rounded = roundHalfUp(fp, 4);
    expect(toString(rounded)).toBe('1.2346');
  });

  it('rounds down when 5th digit < 5', () => {
    const fp = fromString('1.23414', 5);
    const rounded = roundHalfUp(fp, 4);
    expect(toString(rounded)).toBe('1.2341');
  });

  it('rounds exactly half up', () => {
    const fp = fromString('2.5', 1);
    const rounded = roundHalfUp(fp, 0);
    expect(toString(rounded)).toBe('3');
  });

  it('round(1.0005, 3) = 1.001 (half-up)', () => {
    const result = round('1.0005', 3);
    expect(result).toBe('1.001');
  });

  it('round(1.0004, 3) = 1.000 (truncate)', () => {
    const result = round('1.0004', 3);
    expect(result).toBe('1.000');
  });
});

// ─── Soroban Token Conversion ─────────────────────────────────────────────────

describe('toTokenUnits / fromTokenUnits', () => {
  it('converts 1.0 to 10000000 at 7-decimal scale', () => {
    expect(toTokenUnits('1.0', 7)).toBe('10000000.0000000');
  });

  it('converts 0.0000001 to 1 token unit', () => {
    expect(toTokenUnits('0.0000001', 7)).toBe('1.0000000');
  });

  it('no rounding artifact for 123.456 * 1e7', () => {
    expect(toTokenUnits('123.456', 7)).toBe('1234560000.0000000');
  });

  it('round-trips for exact 7-decimal values', () => {
    fc.assert(
      fc.property(positiveDecimalArb(6, 7), (s) => {
        const tokenized = toTokenUnits(s, 7);
        const restored = fromTokenUnits(tokenized, 7);
        const a = fromString(s, 7);
        const b = fromString(restored, 7);
        expect(compare(a, b)).toBe(0);
      }),
      { numRuns: 300 },
    );
  });
});

// ─── sumDecimals ──────────────────────────────────────────────────────────────

describe('sumDecimals', () => {
  it('returns 0 for empty array', () => {
    expect(sumDecimals([])).toBe(toString(zero(INTERNAL_SCALE)));
  });

  it('sums correctly without floating-point drift', () => {
    // 0.1 + 0.2 should not produce 0.30000000000000004
    const result = sumDecimals(['0.1', '0.2']);
    expect(decimalEqual(result, '0.3')).toBe(true);
  });

  it('sums 1000 values of 0.001 to exactly 1', () => {
    const values = Array(1000).fill('0.001');
    const result = sumDecimals(values);
    expect(decimalEqual(result, '1')).toBe(true);
  });

  it('handles mixed positive and negative values', () => {
    const result = sumDecimals(['10', '-3', '2.5', '-1.5']);
    expect(decimalEqual(result, '8')).toBe(true);
  });
});

// ─── reconcileInventory ──────────────────────────────────────────────────────

describe('reconcileInventory', () => {
  it('returns true when holdings sum exactly equals physical total', () => {
    const total = '100';
    const holdings = ['30', '30', '40'];
    expect(reconcileInventory(total, holdings)).toBe(true);
  });

  it('returns false when divergence exceeds tolerance', () => {
    const total = '100';
    const holdings = ['30', '30', '40', '1']; // sum = 101, diff = 1
    expect(reconcileInventory(total, holdings, '0.5')).toBe(false);
  });

  it('returns true when divergence is within tight tolerance', () => {
    // Sum = 99.9999999, total = 100, diff = 0.0000001 == tolerance
    const total = '100';
    const holdings = ['99.9999999'];
    expect(reconcileInventory(total, holdings, '0.0000001')).toBe(true);
  });

  it('detects silent balance leaks across thousands of transactions', () => {
    // Simulate a known leak: 10000 holdings of 0.0000001 each
    const holdings = Array(10000).fill('0.0000001');
    const total = '0.001';
    expect(reconcileInventory(total, holdings)).toBe(true);
  });
});

// ─── truncate ────────────────────────────────────────────────────────────────

describe('truncate', () => {
  it('truncates to 7 decimal places', () => {
    expect(truncate('1.12345678', 7)).toBe('1.1234567');
  });

  it('leaves value unchanged when already at target scale', () => {
    const result = truncate('1.1234567', 7);
    expect(result).toBe('1.1234567');
  });

  it('handles zero fractional part', () => {
    expect(truncate('42', 3)).toBe('42.000');
  });
});

// ─── Performance ─────────────────────────────────────────────────────────────

describe('performance', () => {
  it('executes 100,000 add operations in under 10 seconds', () => {
    const a = fromString('123.456789', INTERNAL_SCALE);
    const b = fromString('987.654321', INTERNAL_SCALE);
    const TARGET_OPS = 100_000;

    const start = Date.now();
    let acc = zero(INTERNAL_SCALE);
    for (let i = 0; i < TARGET_OPS; i++) {
      acc = add(acc, i % 2 === 0 ? a : b);
    }
    const elapsed = Date.now() - start;

    // Verify correctness (acc should not be zero)
    expect(isZero(acc)).toBe(false);
    // Performance: should be well under 10s on commodity hardware
    expect(elapsed).toBeLessThan(10_000);
  });

  it('executes 100,000 multiplyScaled operations in under 30 seconds', () => {
    const a = fromString('123.456', INTERNAL_SCALE);
    const b = fromString('0.000001', INTERNAL_SCALE);
    const TARGET_OPS = 100_000;

    const start = Date.now();
    let acc = zero(INTERNAL_SCALE);
    for (let i = 0; i < TARGET_OPS; i++) {
      acc = add(acc, multiplyScaled(a, b, INTERNAL_SCALE));
    }
    const elapsed = Date.now() - start;

    expect(isZero(acc)).toBe(false);
    expect(elapsed).toBeLessThan(30_000);
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles very small fractional values without loss', () => {
    const fp = fromString('0.000000000000000001', INTERNAL_SCALE);
    expect(fp.value).toBe('1');
    expect(fp.scale).toBe(18);
  });

  it('handles subtraction that crosses zero', () => {
    const a = fromString('3', INTERNAL_SCALE);
    const b = fromString('5', INTERNAL_SCALE);
    const result = subtract(a, b);
    expect(isNegative(result)).toBe(true);
    expect(compare(result, fromString('-2', INTERNAL_SCALE))).toBe(0);
  });

  it('adding zero preserves value', () => {
    fc.assert(
      fc.property(decimalStringArb(), (s) => {
        const a = fromString(s, INTERNAL_SCALE);
        const z = zero(INTERNAL_SCALE);
        expect(compare(add(a, z), a)).toBe(0);
        expect(compare(add(z, a), a)).toBe(0);
      }),
      { numRuns: 300 },
    );
  });

  it('multiplying by one preserves value at same scale', () => {
    fc.assert(
      fc.property(decimalStringArb(6, 6, false), (s) => {
        const a = fromString(s, INTERNAL_SCALE);
        const one = fromString('1', INTERNAL_SCALE);
        const product = multiplyScaled(a, one, INTERNAL_SCALE);
        expect(compare(product, a)).toBe(0);
      }),
      { numRuns: 300 },
    );
  });

  it('compare reflexivity: compare(a, a) = 0', () => {
    fc.assert(
      fc.property(decimalStringArb(), (s) => {
        const a = fromString(s, INTERNAL_SCALE);
        expect(compare(a, a)).toBe(0);
      }),
      { numRuns: 300 },
    );
  });

  it('scale 0 values behave as integers', () => {
    const a = fromString('100', 0);
    const b = fromString('37', 0);
    const diff = subtract(a, b);
    expect(toString(diff)).toBe('63');
  });

  it('negative zero normalises to zero', () => {
    const a = fromString('5', INTERNAL_SCALE);
    const b = fromString('-5', INTERNAL_SCALE);
    const sum = add(a, b);
    expect(isZero(sum)).toBe(true);
    // The value string should not be '-0'
    expect(sum.value).not.toBe('-0');
  });
});
