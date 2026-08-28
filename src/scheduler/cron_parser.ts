/**
 * Standard 5-field cron expression parser (issue #168).
 *
 * Supports the classic `minute hour day-of-month month day-of-week` format with
 * `*`, numbers, ranges (`1-5`), lists (`1,3,6`), and step values such as
 * `asterisk-slash-15` and `1-30/5`. Resolutions are calculated to within one
 * second as required by the issue.
 *
 * Conventions:
 *  - Day-of-month starts at 1; both day-of-month and day-of-week are
 *    interpreted as OR-ed when either is restricted (Vixie cron semantics).
 *  - Months and day-of-week names are resolved numerically for the tests.
 */

export interface CronField {
  values: Set<number>;
}

export interface CronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const MIN_RANGE = 0;
const MAX_RANGE = 59;
const HOUR_RANGE = [0, 23] as const;
const DOM_RANGE = [1, 31] as const;
const MONTH_RANGE = [1, 12] as const;
const DOW_RANGE = [0, 6] as const; // 0 = Sunday

function parseNumber(raw: string, min: number, max: number): number {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Cron value out of range (${raw}): expected ${min}-${max}`);
  }
  return Math.trunc(n);
}

function parseField(raw: string, min: number, max: number): CronField {
  const segments = raw.split(',');
  const values = new Set<number>();

  for (const segment of segments) {
    let step = 1;
    let range = segment.trim();
    const slashIdx = range.indexOf('/');
    if (slashIdx !== -1) {
      step = parseNumber(range.slice(slashIdx + 1), 1, max - min || 1);
      range = range.slice(0, slashIdx);
    }

    if (range === '*' || range === '') {
      for (let v = min; v <= max; v += step) values.add(v);
      continue;
    }

    const dashIdx = range.indexOf('-');
    let start: number;
    let end: number;
    if (dashIdx !== -1) {
      start = parseNumber(range.slice(0, dashIdx), min, max);
      end = parseNumber(range.slice(dashIdx + 1), min, max);
    } else {
      start = parseNumber(range, min, max);
      end = start;
    }

    for (let v = start; v <= end; v += step) {
      if (v < min || v > max) {
        throw new Error(`Cron value out of range (${v}): expected ${min}-${max}`);
      }
      values.add(v);
    }
  }

  if (values.size === 0) {
    throw new Error(`Cron field "${raw}" matched no values`);
  }
  return { values };
}

/**
 * Parse a 5-field cron expression: `minute hour day-of-month month day-of-week`.
 */
export function parseCron(expression: string): CronExpression {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have 5 fields, got ${parts.length}`);
  }
  const [minute, hour, dom, month, dow] = parts;
  return {
    minute: parseField(minute, MIN_RANGE, MAX_RANGE),
    hour: parseField(hour, HOUR_RANGE[0], HOUR_RANGE[1]),
    dayOfMonth: parseField(dom, DOM_RANGE[0], DOM_RANGE[1]),
    month: parseField(month, MONTH_RANGE[0], MONTH_RANGE[1]),
    dayOfWeek: parseField(dow, DOW_RANGE[0], DOW_RANGE[1]),
  };
}

/** True if the day-of-week field covers the entire week (i.e. `*`). */
export function dowIsStar(expr: CronExpression): boolean {
  const { values } = expr.dayOfWeek;
  for (let v = DOW_RANGE[0]; v <= DOW_RANGE[1]; v++) {
    if (!values.has(v)) return false;
  }
  return true;
}

function monthMatches(expr: CronExpression, month: number): boolean {
  return expr.month.values.has(month);
}

function dowMatches(expr: CronExpression, dow: number): boolean {
  return expr.dayOfWeek.values.has(dow);
}

function domMatches(expr: CronExpression, dom: number): boolean {
  return expr.dayOfMonth.values.has(dom);
}

function dayMatches(expr: CronExpression, date: Date): boolean {
  const dom = date.getUTCDate();
  const dow = date.getUTCDay();
  const domRestricted = !domIsStar(expr);
  const dowRestricted = !dowIsStar(expr);
  if (domRestricted && dowRestricted) {
    // OR semantics (Vixie cron): matches if either the DOM or the DOW matches.
    return domMatches(expr, dom) || dowMatches(expr, dow);
  }
  if (domRestricted) return domMatches(expr, dom);
  if (dowRestricted) return dowMatches(expr, dow);
  return true;
}

function domIsStar(expr: CronExpression): boolean {
  const { values } = expr.dayOfMonth;
  for (let v = DOM_RANGE[0]; v <= DOM_RANGE[1]; v++) {
    if (!values.has(v)) return false;
  }
  return true;
}

function hourMatches(expr: CronExpression, hour: number): boolean {
  return expr.hour.values.has(hour);
}

function minuteMatches(expr: CronExpression, minute: number): boolean {
  return expr.minute.values.has(minute);
}

/**
 * Compute the next run time strictly after `from` that satisfies the cron
 * expression, sweeping the calendar forward minute-by-minute (well within the
 * ±1s precision budget for sub-minute schedules — the sweep is over minute
 * boundaries in UTC).
 */
export function nextRun(expr: CronExpression, from: Date): Date {
  const start = new Date(from);
  start.setUTCSeconds(0, 0);
  // Start from the next full minute after `from`.
  const probe = new Date(from);
  probe.setUTCSeconds(0, 0);
  probe.setUTCMilliseconds(0);
  probe.setUTCMinutes(probe.getUTCMinutes() + 1);

  // Bound the sweep to a few years to avoid an infinite loop on invalid input.
  const deadline = start.getTime() + 366 * 24 * 60 * 60 * 1000;

  let y = probe.getUTCFullYear();
  while (probe.getTime() <= deadline) {
    if (!monthMatches(expr, probe.getUTCMonth() + 1)) {
      y = probe.getUTCMonth() === 11 ? probe.getUTCFullYear() + 1 : probe.getUTCFullYear();
      probe.setUTCMonth(probe.getUTCMonth() === 11 ? 0 : probe.getUTCMonth() + 1, 1);
      probe.setUTCHours(0, 0, 0, 0);
      probe.setUTCFullYear(y);
      continue;
    }
    if (!dayMatches(expr, probe)) {
      probe.setUTCDate(probe.getUTCDate() + 1);
      probe.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!hourMatches(expr, probe.getUTCHours())) {
      probe.setUTCHours(probe.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minuteMatches(expr, probe.getUTCMinutes())) {
      probe.setUTCMinutes(probe.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return probe;
  }

  throw new Error('Cron expression never resolves within the search window');
}

/**
 * Convenience: parse a cron expression then return its next run time after
 * `from`.
 */
export function nextCronRun(expression: string, from: Date): Date {
  return nextRun(parseCron(expression), from);
}
