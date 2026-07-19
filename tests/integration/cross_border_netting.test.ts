import { describe, expect, it } from 'vitest';
import { InMemoryFxRateProvider, FxOracle, NettingPeriod } from '../../src/settlement/fx_oracle';
import { MultiCurrencyNettingEngine, NetSettlementInstruction, SettlementTrade } from '../../src/settlement/netting_engine';
import { RollbackManager, SettlementExecutor } from '../../src/settlement/rollback_manager';

const period: NettingPeriod = { id: '2026-07-19', startsAt: new Date('2026-07-19T00:00:00Z'), endsAt: new Date('2026-07-20T00:00:00Z') };

function oracle(): FxOracle {
  const provider = new InMemoryFxRateProvider([
    { pair: 'USD/EUR', timestamp: period.startsAt, rate: 0.9, liquidity: 1_000_000 },
    { pair: 'USD/NGN', timestamp: period.startsAt, rate: 1500, liquidity: 1_000_000 },
    { pair: 'USD/KES', timestamp: period.startsAt, rate: 130, liquidity: 1_000_000 },
    { pair: 'EUR/NGN', timestamp: period.startsAt, rate: 1650, liquidity: 1_000_000 },
    { pair: 'EUR/KES', timestamp: period.startsAt, rate: 142, liquidity: 1_000_000 },
  ]);
  return new FxOracle(provider);
}

describe('cross-border multi-currency netting', () => {
  it('computes bilateral, multilateral and CCP net positions with deferral bounds', async () => {
    const engine = new MultiCurrencyNettingEngine(oracle());
    const trades: SettlementTrade[] = [
      { id: 't1', corridorId: 'us-ng', debtor: 'A', creditor: 'B', sourceCurrency: 'USD', targetCurrency: 'USD', sourceAmount: 150, rail: 'swift' },
      { id: 't2', corridorId: 'us-ng', debtor: 'B', creditor: 'A', sourceCurrency: 'USD', targetCurrency: 'USD', sourceAmount: 40, rail: 'swift' },
      { id: 't3', corridorId: 'us-ng', debtor: 'B', creditor: 'C', sourceCurrency: 'USD', targetCurrency: 'USD', sourceAmount: 110, rail: 'swift' },
      { id: 't4', corridorId: 'us-ng', debtor: 'C', creditor: 'A', sourceCurrency: 'USD', targetCurrency: 'USD', sourceAmount: 80, rail: 'swift', deferredPeriods: 3 },
    ];

    const instructions = await engine.compute(period, trades);

    expect(instructions).toEqual(expect.arrayContaining([
      expect.objectContaining({ debtor: 'A', creditor: 'C', currency: 'USD', amount: 30, status: 'deferred' }),
      expect.objectContaining({ debtor: 'B', creditor: 'C', currency: 'USD', amount: 30, status: 'deferred' }),
    ]));
  });

  it('chaos test rolls back all completed legs when one leg fails', async () => {
    const engine = new MultiCurrencyNettingEngine(oracle(), { minUsdThreshold: 0 });
    const trades: SettlementTrade[] = Array.from({ length: 50 }, (_, i) => ({
      id: `trade-${i}`,
      corridorId: 'chaos',
      debtor: `bank-${i % 5}`,
      creditor: `bank-${(i + 1) % 5}`,
      sourceCurrency: 'USD',
      targetCurrency: 'USD',
      sourceAmount: 100 + i,
      rail: i % 2 === 0 ? 'swift' : 'polygon_usdc',
    }));
    const instructions = await engine.compute(period, trades);
    const failAt = Math.max(1, Math.floor(instructions.length * 0.1));
    const executed: string[] = [];
    const rolledBack: string[] = [];
    const executor: SettlementExecutor = {
      async execute(instruction: NetSettlementInstruction) {
        if (executed.length === failAt) throw new Error('injected failure');
        executed.push(instruction.id);
      },
      async rollback(instruction: NetSettlementInstruction) { rolledBack.push(instruction.id); },
    };

    const result = await new RollbackManager(executor).executeGroup(instructions);

    expect(result.committed).toBe(false);
    expect(rolledBack.sort()).toEqual(executed.sort());
  });
});
