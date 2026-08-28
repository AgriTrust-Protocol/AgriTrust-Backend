import { describe, expect, it } from 'vitest';
import { nextCronRun, nextRun, parseCron } from '../../src/scheduler/cron_parser';

function utc(year: number, month: number, day: number, hour = 0, min = 0, sec = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, min, sec));
}

describe('parseCron', () => {
  it('parses a standard 5-field expression', () => {
    const expr = parseCron('*/15 * * * *');
    // 0, 15, 30, 45 within the minute field
    expect(expr.minute.values.size).toBe(4);
    expect(expr.hour.values.size).toBe(24);
  });

  it('rejects expressions without five fields', () => {
    expect(() => parseCron('* * *')).toThrow('must have 5 fields');
  });

  it('supports ranges', () => {
    const expr = parseCron('0 9-17 * * *');
    expect(expr.hour.values.has(9)).toBe(true);
    expect(expr.hour.values.has(17)).toBe(true);
    expect(expr.hour.values.has(18)).toBe(false);
  });

  it('supports lists', () => {
    const expr = parseCron('0,30 * * * *');
    expect(expr.minute.values.has(0)).toBe(true);
    expect(expr.minute.values.has(30)).toBe(true);
    expect(expr.minute.values.has(15)).toBe(false);
  });

  it('supports ranges with steps', () => {
    const expr = parseCron('0 1-5/2 * * *');
    expect(expr.hour.values.has(1)).toBe(true);
    expect(expr.hour.values.has(3)).toBe(true);
    expect(expr.hour.values.has(5)).toBe(true);
    expect(expr.hour.values.has(2)).toBe(false);
  });

  it('rejects out-of-range hour', () => {
    expect(() => parseCron('0 25 * * *')).toThrow('out of range');
  });
});

describe('nextRun', () => {
  it('returns the next 15-minute boundary', () => {
    const expr = parseCron('*/15 * * * *');
    const from = utc(2026, 8, 28, 10, 3, 0);
    const next = nextRun(expr, from);
    expect(next).toEqual(utc(2026, 8, 28, 10, 15, 0));
  });

  it('respects an exact minute after midnight', () => {
    const expr = parseCron('0 0 * * *');
    const from = utc(2026, 8, 28, 0, 0, 30);
    const next = nextRun(expr, from);
    expect(next).toEqual(utc(2026, 8, 29, 0, 0, 0));
  });

  it('schedules a specific day-of-week', () => {
    // 2026-08-28 is a Friday. Next Monday is 2026-08-31.
    const expr = parseCron('0 6 * * 1'); // 06:00 Monday
    const from = utc(2026, 8, 28, 10, 0, 0);
    const next = nextRun(expr, from);
    expect(next).toEqual(utc(2026, 8, 31, 6, 0, 0));
  });

  it('rolls forward across months', () => {
    const expr = parseCron('0 0 1 * *'); // 1st of month at midnight
    const from = utc(2026, 8, 28, 10, 0, 0);
    const next = nextRun(expr, from);
    expect(next).toEqual(utc(2026, 9, 1, 0, 0, 0));
  });

  it('nextCronRun is a composition helper', () => {
    const from = utc(2026, 8, 28, 10, 3, 0);
    expect(nextCronRun('*/15 * * * *', from)).toEqual(utc(2026, 8, 28, 10, 15, 0));
  });
});
