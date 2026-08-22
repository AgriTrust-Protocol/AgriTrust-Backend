/**
 * Fixed-Point Decimal Math Engine
 *
 * Implements arbitrary-precision decimal arithmetic using string-based
 * integer representation to eliminate f64/Number rounding artifacts that
 * arise when converting physical commodity measurements (metric tons,
 * bushels, liters) to Web3 tokenized units across varying decimal regimes.
 *
 * Design invariants (issue #176):
 *   - No f64 or JavaScript Number used for value storage or arithmetic.
 *   - Internal precision: minimum 18 decimal places.
 *   - Output truncated to 7 decimal places for Soroban compatibility.
 *   - Overflow detection: mul of two 18-decimal values checks i128 max.
 *   - Karatsuba multiplication used for operand digit strings > 20 chars.
 *   - Supported: add, subtract, multiply, divide, compare, floor, round half-up.
 */

import { FixedPoint, MathError, INTERNAL_SCALE, SOROBAN_SCALE, I128_MAX } from './types';

// ─── String Integer Utilities ─────────────────────────────────────────────────

/**
 * Remove a leading '-' and return [isNegative, absoluteValueString].
 */
function splitSign(s: string): [boolean, string] {
  if (s.startsWith('-')) {
    return [true, s.slice(1)];
  }
  return [false, s];
}

/** Strip leading zeros from a digit string, preserving at least one digit. */
function stripLeadingZeros(s: string): string {
  const stripped = s.replace(/^0+/, '');
  return stripped.length === 0 ? '0' : stripped;
}

/** Pad a digit string with leading zeros to reach targetLength. */
function padLeft(s: string, targetLength: number): string {
  while (s.length < targetLength) {
    s = '0' + s;
  }
  return s;
}

/** Pad a digit string with trailing zeros to reach targetLength. */
function padRight(s: string, targetLength: number): string {
  while (s.length < targetLength) {
    s = s + '0';
  }
  return s;
}

/**
 * Compare two non-negative digit strings as integers.
 * Returns -1, 0, or 1.
 */
function compareAbs(a: string, b: string): -1 | 0 | 1 {
  if (a.length !== b.length) {
    return a.length < b.length ? -1 : 1;
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Add two non-negative digit strings.
 * Returns the digit string of their sum.
 */
function addAbs(a: string, b: string): string {
  // Align lengths
  const len = Math.max(a.length, b.length);
  a = padLeft(a, len);
  b = padLeft(b, len);

  let carry = 0;
  let result = '';
  for (let i = len - 1; i >= 0; i--) {
    const sum = a.charCodeAt(i) - 48 + (b.charCodeAt(i) - 48) + carry;
    carry = sum >= 10 ? 1 : 0;
    result = String.fromCharCode((sum % 10) + 48) + result;
  }
  if (carry > 0) {
    result = '1' + result;
  }
  return result;
}

/**
 * Subtract non-negative digit string b from a where a >= b.
 * Returns the digit string of (a - b).
 */
function subtractAbs(a: string, b: string): string {
  const len = Math.max(a.length, b.length);
  a = padLeft(a, len);
  b = padLeft(b, len);

  let borrow = 0;
  let result = '';
  for (let i = len - 1; i >= 0; i--) {
    let diff = a.charCodeAt(i) - 48 - (b.charCodeAt(i) - 48) - borrow;
    if (diff < 0) {
      diff += 10;
      borrow = 1;
    } else {
      borrow = 0;
    }
    result = String.fromCharCode(diff + 48) + result;
  }
  return stripLeadingZeros(result);
}

/**
 * Multiply a digit string by a single digit (0-9).
 */
function multiplyByDigit(a: string, digit: number): string {
  if (digit === 0) return '0';
  let carry = 0;
  let result = '';
  for (let i = a.length - 1; i >= 0; i--) {
    const prod = (a.charCodeAt(i) - 48) * digit + carry;
    carry = Math.floor(prod / 10);
    result = String.fromCharCode((prod % 10) + 48) + result;
  }
  if (carry > 0) {
    result = String(carry) + result;
  }
  return result;
}

/**
 * Standard O(n²) long multiplication of two non-negative digit strings.
 */
function multiplyAbsGrade(a: string, b: string): string {
  const result = new Array<number>(a.length + b.length).fill(0);

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const mul = (a.charCodeAt(i) - 48) * (b.charCodeAt(j) - 48);
      const pos1 = i + j;
      const pos2 = i + j + 1;
      const sum = mul + result[pos2];

      result[pos2] = sum % 10;
      result[pos1] += Math.floor(sum / 10);
    }
  }

  const str = result.join('');
  return stripLeadingZeros(str);
}

/**
 * Karatsuba multiplication for two non-negative digit strings.
 * Used when either operand is > 20 digits to stay within performance bounds.
 *
 * Algorithm: splits each number at mid-point m, then:
 *   a = a1 * 10^m + a0
 *   b = b1 * 10^m + b0
 *   a*b = z2*10^(2m) + (z1-z2-z0)*10^m + z0
 *   where z0=a0*b0, z2=a1*b1, z1=(a0+a1)*(b0+b1)
 */
function multiplyAbsKaratsuba(a: string, b: string): string {
  // Base case: use grade-school for small inputs
  if (a.length <= 20 || b.length <= 20) {
    return multiplyAbsGrade(a, b);
  }

  const m = Math.floor(Math.max(a.length, b.length) / 2);

  // Split: a = a1 * 10^m + a0
  const a0 = a.length > m ? a.slice(a.length - m) : a;
  const a1 = a.length > m ? stripLeadingZeros(a.slice(0, a.length - m)) : '0';
  const b0 = b.length > m ? b.slice(b.length - m) : b;
  const b1 = b.length > m ? stripLeadingZeros(b.slice(0, b.length - m)) : '0';

  const z0 = multiplyAbsKaratsuba(a0, b0);
  const z2 = multiplyAbsKaratsuba(a1, b1);
  const z1 = multiplyAbsKaratsuba(addAbs(a0, a1), addAbs(b0, b1));

  // middle = z1 - z2 - z0
  const middle = subtractAbs(z1, addAbs(z2, z0));

  // result = z2 * 10^(2m) + middle * 10^m + z0
  const z2shifted = z2 === '0' ? '0' : z2 + padRight('', 2 * m);
  const midShifted = middle === '0' ? '0' : middle + padRight('', m);

  return addAbs(addAbs(z2shifted, midShifted), z0);
}

/**
 * Multiply two non-negative digit strings, choosing algorithm based on size.
 */
function multiplyAbs(a: string, b: string): string {
  if (a === '0' || b === '0') return '0';
  if (a.length > 20 && b.length > 20) {
    return multiplyAbsKaratsuba(a, b);
  }
  return multiplyAbsGrade(a, b);
}

/**
 * Divide non-negative digit string dividend by divisor, returning
 * { quotient, remainder } as digit strings.
 *
 * Long division algorithm.
 */
function divideAbs(dividend: string, divisor: string): { quotient: string; remainder: string } {
  if (divisor === '0') {
    throw new MathError('Division by zero', 'DIVISION_BY_ZERO');
  }
  if (compareAbs(dividend, divisor) === -1) {
    return { quotient: '0', remainder: dividend };
  }

  let remainder = '0';
  let quotient = '';

  for (let i = 0; i < dividend.length; i++) {
    remainder = addAbs(remainder === '0' ? '' : remainder, dividend[i]);
    if (remainder === '') remainder = dividend[i];

    // Find the largest digit d such that d * divisor <= remainder
    let d = 0;
    let lo = 0;
    let hi = 9;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = multiplyByDigit(divisor, mid);
      if (compareAbs(candidate, remainder) <= 0) {
        d = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    quotient += String(d);
    remainder = subtractAbs(remainder, multiplyByDigit(divisor, d));
  }

  return {
    quotient: stripLeadingZeros(quotient),
    remainder: stripLeadingZeros(remainder),
  };
}

// ─── FixedPoint Construction ──────────────────────────────────────────────────

/**
 * Parse a decimal string into a FixedPoint at the specified scale.
 *
 * Accepts strings like: "123.456", "-0.001", "1000", ".5", "-.5"
 * Strips leading/trailing whitespace.
 * Validates all characters are in [0-9.-].
 *
 * @param s      The decimal string to parse.
 * @param scale  The target internal scale (defaults to INTERNAL_SCALE = 18).
 */
export function fromString(s: string, scale: number = INTERNAL_SCALE): FixedPoint {
  s = s.trim();

  if (!/^-?[0-9]*\.?[0-9]+$/.test(s)) {
    throw new MathError(
      `Invalid decimal string: "${s}". Expected format: optional '-', digits, optional decimal point.`,
      'INVALID_INPUT',
    );
  }

  if (scale < 0 || scale > 38) {
    throw new MathError(`Scale must be between 0 and 38, got ${scale}`, 'INVALID_INPUT');
  }

  const negative = s.startsWith('-');
  if (negative) s = s.slice(1);

  // Split on decimal point
  const dotIndex = s.indexOf('.');
  let intPart: string;
  let fracPart: string;

  if (dotIndex === -1) {
    intPart = s;
    fracPart = '';
  } else {
    intPart = s.slice(0, dotIndex);
    fracPart = s.slice(dotIndex + 1);
  }

  intPart = intPart === '' ? '0' : intPart;

  // Truncate or pad the fractional part to `scale` digits
  if (fracPart.length > scale) {
    fracPart = fracPart.slice(0, scale);
  } else {
    fracPart = padRight(fracPart, scale);
  }

  const combined = stripLeadingZeros(intPart + fracPart);

  if (combined === '0') {
    return { value: '0', scale };
  }

  return {
    value: negative ? '-' + combined : combined,
    scale,
  };
}

/**
 * Convert a FixedPoint back to a human-readable decimal string.
 * The fractional digits are scaled by `fp.scale`.
 */
export function toString(fp: FixedPoint): string {
  const [negative, abs] = splitSign(fp.value);

  if (fp.scale === 0) {
    return negative ? '-' + abs : abs;
  }

  const paddedAbs = padLeft(abs, fp.scale + 1);
  const intPart = stripLeadingZeros(paddedAbs.slice(0, paddedAbs.length - fp.scale));
  const fracPart = paddedAbs.slice(paddedAbs.length - fp.scale);

  const result = intPart + '.' + fracPart;
  return negative ? '-' + result : result;
}

/**
 * Convert a FixedPoint to a string truncated to `outputScale` decimal places.
 * Defaults to SOROBAN_SCALE (7) for Soroban compatibility.
 */
export function toSorobanString(fp: FixedPoint, outputScale: number = SOROBAN_SCALE): string {
  // Re-scale to outputScale first, then convert to string
  const rescaled = rescale(fp, outputScale);
  return toString(rescaled);
}

// ─── Scale Alignment ──────────────────────────────────────────────────────────

/**
 * Rescale a FixedPoint to a new scale, truncating if scale decreases.
 */
function rescale(fp: FixedPoint, newScale: number): FixedPoint {
  if (fp.scale === newScale) return fp;

  const [negative, abs] = splitSign(fp.value);

  if (newScale > fp.scale) {
    // Multiply by 10^(newScale - fp.scale)
    const factor = '1' + '0'.repeat(newScale - fp.scale);
    const newAbs = multiplyAbs(abs, factor);
    return { value: negative ? '-' + newAbs : newAbs, scale: newScale };
  } else {
    // Truncate by integer-dividing by 10^(fp.scale - newScale)
    const factor = '1' + '0'.repeat(fp.scale - newScale);
    const { quotient } = divideAbs(abs, factor);
    const result = quotient === '0' ? '0' : negative ? '-' + quotient : quotient;
    return { value: result, scale: newScale };
  }
}

/**
 * Align two FixedPoints to the same (higher) scale for arithmetic.
 */
function align(a: FixedPoint, b: FixedPoint): [FixedPoint, FixedPoint] {
  const targetScale = Math.max(a.scale, b.scale);
  return [rescale(a, targetScale), rescale(b, targetScale)];
}

// ─── Arithmetic Operations ────────────────────────────────────────────────────

/**
 * Add two FixedPoint values.
 * Aligns scales before adding. Result has scale = max(a.scale, b.scale).
 */
export function add(a: FixedPoint, b: FixedPoint): FixedPoint {
  const [aa, bb] = align(a, b);
  const scale = aa.scale;

  const [aNeg, aAbs] = splitSign(aa.value);
  const [bNeg, bAbs] = splitSign(bb.value);

  let resultValue: string;

  if (aNeg === bNeg) {
    // Same sign: add magnitudes, keep sign
    const sum = addAbs(aAbs, bAbs);
    resultValue = aNeg ? '-' + sum : sum;
  } else {
    // Different sign: subtract smaller from larger
    const cmp = compareAbs(aAbs, bAbs);
    if (cmp === 0) {
      resultValue = '0';
    } else if (cmp > 0) {
      const diff = subtractAbs(aAbs, bAbs);
      resultValue = aNeg ? '-' + diff : diff;
    } else {
      const diff = subtractAbs(bAbs, aAbs);
      resultValue = bNeg ? '-' + diff : diff;
    }
  }

  return { value: resultValue, scale };
}

/**
 * Subtract b from a.
 * Equivalent to a + (-b).
 */
export function subtract(a: FixedPoint, b: FixedPoint): FixedPoint {
  const negB: FixedPoint = {
    value: b.value === '0' ? '0' : b.value.startsWith('-') ? b.value.slice(1) : '-' + b.value,
    scale: b.scale,
  };
  return add(a, negB);
}

/**
 * Multiply two FixedPoint values.
 * Product scale = a.scale + b.scale (full precision product).
 *
 * Overflow protection: if both scales are INTERNAL_SCALE (18), the product
 * is checked against i128::MAX before being returned.
 *
 * @throws MathError('OVERFLOW') if the product exceeds i128 max.
 */
export function multiply(a: FixedPoint, b: FixedPoint): FixedPoint {
  const [aNeg, aAbs] = splitSign(a.value);
  const [bNeg, bAbs] = splitSign(b.value);

  const productAbs = multiplyAbs(aAbs, bAbs);
  const productScale = a.scale + b.scale;

  // Overflow guard: when both operands are at scale=18, the scaled integer
  // product must not exceed i128 max.
  if (a.scale === INTERNAL_SCALE && b.scale === INTERNAL_SCALE) {
    if (compareAbs(productAbs, I128_MAX) > 0) {
      throw new MathError(
        `Multiplication overflow: product exceeds i128 max (${I128_MAX})`,
        'OVERFLOW',
      );
    }
  }

  const resultNeg = aNeg !== bNeg;
  const resultValue = productAbs === '0' ? '0' : resultNeg ? '-' + productAbs : productAbs;

  return { value: resultValue, scale: productScale };
}

/**
 * Multiply two FixedPoint values and return the result at a specified scale.
 * Rescales the raw product (scale = a.scale + b.scale) down to targetScale,
 * applying round-half-up at the cut-off digit.
 *
 * @param a           The multiplicand.
 * @param b           The multiplier.
 * @param targetScale The output scale (defaults to INTERNAL_SCALE).
 */
export function multiplyScaled(
  a: FixedPoint,
  b: FixedPoint,
  targetScale: number = INTERNAL_SCALE,
): FixedPoint {
  const rawProduct = multiply(a, b);
  return roundHalfUp(rawProduct, targetScale);
}

/**
 * Divide a by b, producing a result at targetScale decimal places.
 * Uses long division with round-half-up at the cut-off digit.
 *
 * Derivation of the scaling:
 *   a_real = aAbs / 10^a.scale
 *   b_real = bAbs / 10^b.scale
 *   result_real = a_real / b_real = (aAbs / bAbs) * 10^(b.scale - a.scale)
 *
 * To obtain the quotient as an integer at targetScale, we need:
 *   quotient_int = result_real * 10^targetScale
 *               = (aAbs / bAbs) * 10^(b.scale - a.scale + targetScale)
 *
 * We compute one extra digit for rounding:
 *   scaledDividend = aAbs * 10^(b.scale - a.scale + targetScale + 1)
 *   rawQuotient    = scaledDividend / bAbs  (integer long division)
 *   roundedQuotient = round_half_up(rawQuotient, drop 1 digit)
 *
 * @throws MathError('DIVISION_BY_ZERO') if b is zero.
 */
export function divide(
  a: FixedPoint,
  b: FixedPoint,
  targetScale: number = INTERNAL_SCALE,
): FixedPoint {
  if (b.value === '0') {
    throw new MathError('Division by zero', 'DIVISION_BY_ZERO');
  }

  const [aNeg, aAbs] = splitSign(a.value);
  const [bNeg, bAbs] = splitSign(b.value);

  // Number of zeros to append to aAbs before dividing by bAbs.
  // Net scale shift = b.scale - a.scale + targetScale + 1 (the +1 is for rounding digit).
  const scaleShift = b.scale - a.scale + targetScale + 1;

  let scaledDividend: string;
  if (scaleShift >= 0) {
    scaledDividend = aAbs + '0'.repeat(scaleShift);
  } else {
    // aAbs needs to be divided by 10^(-scaleShift) first (truncate)
    const trimLen = -scaleShift;
    scaledDividend = aAbs.length > trimLen ? aAbs.slice(0, aAbs.length - trimLen) : '0';
    if (scaledDividend === '') scaledDividend = '0';
  }

  const { quotient } = divideAbs(scaledDividend, bAbs);

  // Round half-up: examine the last digit and drop it
  let roundedQuotient = quotient;
  if (roundedQuotient.length > 0) {
    const lastDigit = roundedQuotient.charCodeAt(roundedQuotient.length - 1) - 48;
    roundedQuotient = roundedQuotient.slice(0, -1) || '0';
    if (lastDigit >= 5) {
      roundedQuotient = addAbs(roundedQuotient, '1');
    }
  } else {
    roundedQuotient = '0';
  }

  const resultNeg = aNeg !== bNeg;
  const finalValue =
    roundedQuotient === '0' ? '0' : resultNeg ? '-' + roundedQuotient : roundedQuotient;

  return { value: finalValue, scale: targetScale };
}

// ─── Comparison ───────────────────────────────────────────────────────────────

/**
 * Compare two FixedPoint values.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compare(a: FixedPoint, b: FixedPoint): -1 | 0 | 1 {
  const [aa, bb] = align(a, b);
  const [aNeg, aAbs] = splitSign(aa.value);
  const [bNeg, bAbs] = splitSign(bb.value);

  if (aNeg && !bNeg) return -1;
  if (!aNeg && bNeg) return 1;

  const absResult = compareAbs(aAbs, bAbs);
  if (aNeg) {
    // Both negative: larger absolute value means smaller number
    if (absResult === -1) return 1;
    if (absResult === 1) return -1;
    return 0;
  }
  return absResult;
}

// ─── Rounding ─────────────────────────────────────────────────────────────────

/**
 * Truncate a FixedPoint to `targetScale` decimal places (floor toward zero).
 * Equivalent to Rust's truncating integer division.
 */
export function floor(fp: FixedPoint, targetScale = 0): FixedPoint {
  if (fp.scale <= targetScale) {
    return rescale(fp, targetScale);
  }
  return rescale(fp, targetScale); // rescale truncates toward zero
}

/**
 * Round a FixedPoint to `targetScale` decimal places using round-half-up.
 * The digit immediately after the cut-off determines rounding:
 *   digit >= 5 → round up (away from zero for positive numbers)
 *   digit <  5 → truncate
 */
export function roundHalfUp(fp: FixedPoint, targetScale: number): FixedPoint {
  if (fp.scale <= targetScale) {
    return rescale(fp, targetScale);
  }

  const [negative, abs] = splitSign(fp.value);
  const dropDigits = fp.scale - targetScale;

  if (dropDigits <= 0) {
    return fp;
  }

  // Get the first dropped digit to decide rounding
  const paddedAbs = padLeft(abs, dropDigits + 1);
  const pivotDigit = paddedAbs.charCodeAt(paddedAbs.length - dropDigits) - 48;
  const truncated = paddedAbs.slice(0, paddedAbs.length - dropDigits);
  const truncatedClean = stripLeadingZeros(truncated) || '0';

  let rounded: string;
  if (pivotDigit >= 5) {
    rounded = addAbs(truncatedClean, '1');
  } else {
    rounded = truncatedClean;
  }

  const resultValue = rounded === '0' ? '0' : negative ? '-' + rounded : rounded;
  return { value: resultValue, scale: targetScale };
}

// ─── Convenience Factories ────────────────────────────────────────────────────

/**
 * Create a FixedPoint from a JavaScript integer (safe integer range).
 * Stored at the given scale with a zero fractional part.
 */
export function fromInteger(n: number, scale: number = INTERNAL_SCALE): FixedPoint {
  if (!Number.isInteger(n)) {
    throw new MathError(`fromInteger requires an integer, got ${n}`, 'INVALID_INPUT');
  }
  const negative = n < 0;
  const abs = Math.abs(n).toString();
  const scaledAbs = abs + '0'.repeat(scale);
  return {
    value: negative ? '-' + scaledAbs : scaledAbs,
    scale,
  };
}

/**
 * Alias: create a zero value at the given scale.
 */
export function zero(scale: number = INTERNAL_SCALE): FixedPoint {
  return { value: '0', scale };
}

/**
 * Returns true if the FixedPoint value is zero.
 */
export function isZero(fp: FixedPoint): boolean {
  return fp.value === '0';
}

/**
 * Returns true if the FixedPoint value is negative.
 */
export function isNegative(fp: FixedPoint): boolean {
  return fp.value.startsWith('-') && fp.value !== '0';
}

// ─── Re-exports ────────────────────────────────────────────────────────────────

export { rescale };
export type { FixedPoint };
export { INTERNAL_SCALE, SOROBAN_SCALE, MathError };
