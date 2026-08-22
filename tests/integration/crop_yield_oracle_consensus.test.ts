import { describe, expect, it } from 'vitest';
import { computeWeightedConsensus } from '../../src/oracle/consensus';
import { normalizeYieldReports, YieldReport } from '../../src/oracle/ingestion';
import { updateTrustScore } from '../../src/oracle/trust_score';

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('crop yield oracle consensus', () => {
  it('rejects a rogue report and keeps consensus within 5% of verified yield', () => {
    const trueYield = 6000;
    const reports: YieldReport[] = [
      {
        farmId: 'farm-1',
        seasonId: '2026-main',
        sourceType: 'satellite',
        value: 5.95,
        unit: 'tonnes_per_hectare',
        timestamp: new Date('2026-07-19T00:00:00Z'),
        reporterId: 'sat-1',
      },
      {
        farmId: 'farm-1',
        seasonId: '2026-main',
        sourceType: 'iot',
        value: 6020,
        unit: 'kg_per_hectare',
        timestamp: new Date('2026-07-19T00:15:00Z'),
        reporterId: 'soil-1',
      },
      {
        farmId: 'farm-1',
        seasonId: '2026-main',
        sourceType: 'drone',
        value: 9000,
        unit: 'kg_per_hectare',
        timestamp: new Date('2026-07-19T00:30:00Z'),
        reporterId: 'drone-compromised',
      },
      {
        farmId: 'farm-1',
        seasonId: '2026-main',
        sourceType: 'manual',
        value: 5980,
        unit: 'kg_per_hectare',
        timestamp: new Date('2026-07-19T01:00:00Z'),
        reporterId: 'agent-1',
      },
      {
        farmId: 'farm-1',
        seasonId: '2026-main',
        sourceType: 'iot',
        value: 6075,
        unit: 'kg_per_hectare',
        timestamp: new Date('2026-07-19T01:10:00Z'),
        reporterId: 'soil-2',
      },
    ];

    const normalized = normalizeYieldReports(reports);
    const trustScores = new Map(normalized.map((report) => [report.sourceId, 0.9]));
    trustScores.set('drone:drone-compromised', 1);

    const consensus = computeWeightedConsensus(normalized, {
      trustScores,
      bootstrapResamples: 10_000,
      random: seededRandom(82),
    });

    expect(consensus.rejectedSourceIds).toEqual(['drone:drone-compromised']);
    expect(consensus.sourceCount).toBe(4);
    expect(consensus.penaltyFlag).toBe(false);
    expect(Math.abs(consensus.yieldEstimate - trueYield) / trueYield).toBeLessThanOrEqual(0.05);
    expect(consensus.confidenceInterval.lower).toBeLessThanOrEqual(consensus.yieldEstimate);
    expect(consensus.confidenceInterval.upper).toBeGreaterThanOrEqual(consensus.yieldEstimate);
  });

  it('updates source trust using seasonal verified accuracy', () => {
    expect(updateTrustScore(0.8, 5900, 6000)).toBeCloseTo(0.818333, 5);
  });
});
