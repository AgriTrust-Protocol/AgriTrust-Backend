import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY_99_99,
  evaluateBurnRate,
  evaluateMultiWindowBurnRate,
} from '../../src/slo/burn-rate';

describe('SLO burn rate evaluation', () => {
  it('calculates burn rate against a 99.99% availability error budget', () => {
    const result = evaluateBurnRate(AVAILABILITY_99_99, {
      label: '5m',
      durationHours: 5 / 60,
      totalEvents: 1_000_000,
      badEvents: 2_000,
    });

    expect(result.errorBudget).toBeCloseTo(0.0001, 8);
    expect(result.observedErrorRatio).toBe(0.002);
    expect(result.burnRate).toBeCloseTo(20, 6);
    expect(result.projectedBudgetHoursRemaining).toBeCloseTo(36, 6);
  });

  it('treats empty windows as no budget burn', () => {
    const result = evaluateBurnRate(AVAILABILITY_99_99, {
      label: '1h',
      durationHours: 1,
      totalEvents: 0,
      badEvents: 0,
    });

    expect(result.observedErrorRatio).toBe(0);
    expect(result.burnRate).toBe(0);
    expect(result.projectedBudgetHoursRemaining).toBeNull();
  });

  it('pages only when paired fast-burn windows breach together', () => {
    const result = evaluateMultiWindowBurnRate(AVAILABILITY_99_99, [
      { label: '5m', durationHours: 5 / 60, totalEvents: 100_000, badEvents: 200 },
      { label: '1h', durationHours: 1, totalEvents: 1_200_000, badEvents: 2_400 },
      { label: '30m', durationHours: 0.5, totalEvents: 600_000, badEvents: 0 },
      { label: '6h', durationHours: 6, totalEvents: 7_200_000, badEvents: 0 },
    ]);

    expect(result.severity).toBe('page');
    expect(result.reasons[0]).toContain('fast burn page');
  });

  it('opens a ticket for sustained medium burn below paging threshold', () => {
    const result = evaluateMultiWindowBurnRate(AVAILABILITY_99_99, [
      { label: '2h', durationHours: 2, totalEvents: 2_000_000, badEvents: 700 },
      { label: '24h', durationHours: 24, totalEvents: 24_000_000, badEvents: 8_400 },
    ]);

    expect(result.severity).toBe('ticket');
    expect(result.reasons[0]).toContain('ticket');
  });

  it('rejects impossible event counts', () => {
    expect(() =>
      evaluateBurnRate(AVAILABILITY_99_99, {
        label: '5m',
        durationHours: 5 / 60,
        totalEvents: 10,
        badEvents: 11,
      }),
    ).toThrow('badEvents cannot exceed totalEvents');
  });
});
