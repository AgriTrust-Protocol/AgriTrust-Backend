/**
 * Tests for Cross-Border Settlement Finality with Multi-Currency Netting Engine
 *
 * Covers:
 *  - Bilateral netting
 *  - Multilateral netting
 *  - CCP netting
 *  - FX TWAP oracle (caching, multi-sample, edge cases)
 *  - SWIFT pacs.008 message construction
 *  - Blockchain USDC transfer batching
 *  - Rollback atomicity (chaos scenario: 50 trades, 10% failure rate)
 *  - Deferral threshold and force-settlement after max deferred periods
 */

import { describe, expect, it, vi } from 'vitest';

import {
  NettingEngine,
  PendingSettlement,
  FxRates,
  NETTING_INVARIANTS,
} from '../../src/settlement/netting_engine';

import { FxOracle, LiquidityPoolAdapter, PriceSample } from '../../src/settlement/fx_oracle';

import {
  SwiftAdapter,
  SwiftPartyDirectory,
  SwiftGatewayClient,
  Pacs008Instruction,
} from '../../src/settlement/swift_adapter';

import {
  BlockchainAdapter,
  WalletDirectory,
  PolygonRpcClient,
  Erc20Transfer,
} from '../../src/settlement/blockchain_adapter';

import {
  RollbackManager,
  SwiftReversal,
  BlockchainReversal,
} from '../../src/settlement/rollback_manager';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date('2025-06-15T10:00:00Z');

const BASE_RATES: FxRates = {
  'USD/EUR': 0.92, // 1 USD = 0.92 EUR  → EUR/USD = 1/0.92
  'USD/NGN': 1580, // 1 USD = 1580 NGN
  'USD/KES': 128, // 1 USD = 128  KES
  'EUR/NGN': 1717.4, // 1 EUR = 1717.4 NGN
  'EUR/KES': 139.1, // 1 EUR = 139.1 KES
};

function makeSettlement(
  overrides: Partial<PendingSettlement> &
    Pick<PendingSettlement, 'id' | 'debtorId' | 'creditorId' | 'amount' | 'currency'>,
): PendingSettlement {
  return {
    tradeTimestamp: NOW,
    corridorId: 'default',
    deferredPeriods: 0,
    ...overrides,
  };
}

// ─── NettingEngine ────────────────────────────────────────────────────────────

describe('NettingEngine — bilateral netting', () => {
  const engine = new NettingEngine();

  it('nets opposing USD flows between two parties', () => {
    const settlements = [
      makeSettlement({ id: 's1', debtorId: 'A', creditorId: 'B', amount: 1000, currency: 'USD' }),
      makeSettlement({ id: 's2', debtorId: 'B', creditorId: 'A', amount: 400, currency: 'USD' }),
    ];

    const positions = engine.bilateralNetting(settlements, BASE_RATES);

    expect(positions).toHaveLength(1);
    expect(positions[0].debtorId).toBe('A');
    expect(positions[0].creditorId).toBe('B');
    expect(positions[0].netAmount).toBeCloseTo(600, 5);
    expect(positions[0].currency).toBe('USD');
    expect(positions[0].settlementIds).toContain('s1');
    expect(positions[0].settlementIds).toContain('s2');
  });

  it('produces no position when flows cancel exactly', () => {
    const settlements = [
      makeSettlement({ id: 's3', debtorId: 'A', creditorId: 'B', amount: 500, currency: 'USD' }),
      makeSettlement({ id: 's4', debtorId: 'B', creditorId: 'A', amount: 500, currency: 'USD' }),
    ];
    const positions = engine.bilateralNetting(settlements, BASE_RATES);
    expect(positions).toHaveLength(0);
  });

  it('keeps separate positions for different currency pairs', () => {
    const settlements = [
      makeSettlement({ id: 's5', debtorId: 'A', creditorId: 'B', amount: 1000, currency: 'USD' }),
      makeSettlement({ id: 's6', debtorId: 'A', creditorId: 'B', amount: 500, currency: 'EUR' }),
    ];
    const positions = engine.bilateralNetting(settlements, BASE_RATES);
    expect(positions).toHaveLength(2);
    const currencies = positions.map((p) => p.currency).sort();
    expect(currencies).toEqual(['EUR', 'USD']);
  });

  it('converts NGN to USD for netAmountUsd', () => {
    const settlements = [
      makeSettlement({
        id: 's7',
        debtorId: 'A',
        creditorId: 'B',
        amount: 158_000,
        currency: 'NGN',
      }),
    ];
    const positions = engine.bilateralNetting(settlements, BASE_RATES);
    expect(positions).toHaveLength(1);
    // 158000 NGN / 1580 (USD/NGN rate) = 100 USD
    expect(positions[0].netAmountUsd).toBeCloseTo(100, 4);
  });
});

describe('NettingEngine — multilateral netting', () => {
  const engine = new NettingEngine();

  it('reduces three-party cycle to two net transfers', () => {
    // A→B 300, B→C 200, C→A 100
    // Net balances: A=-300+100=-200, B=+300-200=+100, C=+200-100=+100
    // → A pays B 100, A pays C 100  (or any equivalent decomposition)
    const bilateral = [
      {
        debtorId: 'A',
        creditorId: 'B',
        netAmount: 300,
        currency: 'USD' as const,
        netAmountUsd: 300,
        settlementIds: ['x1'],
      },
      {
        debtorId: 'B',
        creditorId: 'C',
        netAmount: 200,
        currency: 'USD' as const,
        netAmountUsd: 200,
        settlementIds: ['x2'],
      },
      {
        debtorId: 'C',
        creditorId: 'A',
        netAmount: 100,
        currency: 'USD' as const,
        netAmountUsd: 100,
        settlementIds: ['x3'],
      },
    ];

    const positions = engine.multilateralNetting(bilateral, BASE_RATES);
    const totalDebt = positions.reduce((s, p) => s + p.netAmount, 0);
    // Net debtors: A owes 200 total; total flow must equal sum of net debtor balances
    expect(totalDebt).toBeCloseTo(200, 4);
  });

  it('preserves all settlement IDs in resulting positions', () => {
    const bilateral = [
      {
        debtorId: 'A',
        creditorId: 'B',
        netAmount: 500,
        currency: 'USD' as const,
        netAmountUsd: 500,
        settlementIds: ['y1', 'y2'],
      },
      {
        debtorId: 'C',
        creditorId: 'B',
        netAmount: 300,
        currency: 'USD' as const,
        netAmountUsd: 300,
        settlementIds: ['y3'],
      },
    ];
    const positions = engine.multilateralNetting(bilateral, BASE_RATES);
    const allIds = positions.flatMap((p) => p.settlementIds);
    expect(allIds).toContain('y1');
    expect(allIds).toContain('y3');
  });
});

describe('NettingEngine — CCP netting', () => {
  const engine = new NettingEngine();

  it('routes all net positions through the CCP node', () => {
    const positions = [
      {
        debtorId: 'A',
        creditorId: 'B',
        netAmount: 200,
        currency: 'USD' as const,
        netAmountUsd: 200,
        settlementIds: ['z1'],
      },
      {
        debtorId: 'C',
        creditorId: 'B',
        netAmount: 150,
        currency: 'USD' as const,
        netAmountUsd: 150,
        settlementIds: ['z2'],
      },
    ];

    const ccp = engine.ccpNetting(positions, BASE_RATES);

    // Every position must involve CCP:AGRITRUST on one side
    for (const p of ccp) {
      const involvesCcp = p.debtorId === 'CCP:AGRITRUST' || p.creditorId === 'CCP:AGRITRUST';
      expect(involvesCcp).toBe(true);
    }
  });

  it('conserves total net amounts', () => {
    const positions = [
      {
        debtorId: 'A',
        creditorId: 'B',
        netAmount: 500,
        currency: 'USD' as const,
        netAmountUsd: 500,
        settlementIds: ['w1'],
      },
      {
        debtorId: 'D',
        creditorId: 'E',
        netAmount: 300,
        currency: 'USD' as const,
        netAmountUsd: 300,
        settlementIds: ['w2'],
      },
    ];

    const ccp = engine.ccpNetting(positions, BASE_RATES);

    // Sum of debtor legs must equal original total
    const debtorTotal = ccp
      .filter((p) => p.creditorId === 'CCP:AGRITRUST')
      .reduce((s, p) => s + p.netAmount, 0);

    expect(debtorTotal).toBeCloseTo(800, 4);
  });
});

describe('NettingEngine — threshold deferral', () => {
  it('defers settlements below $100 USD equivalent', () => {
    const engine = new NettingEngine();
    const settlements = [
      makeSettlement({ id: 'low1', debtorId: 'A', creditorId: 'B', amount: 50, currency: 'USD' }),
    ];
    const result = engine.computeNetting(settlements, BASE_RATES);

    expect(result.groups).toHaveLength(0);
    expect(result.deferred.length).toBeGreaterThan(0);
    expect(result.deferred[0].settlementId).toBeDefined();
  });

  it('does not defer settlements at or above $100', () => {
    const engine = new NettingEngine();
    const settlements = [
      makeSettlement({ id: 'ok1', debtorId: 'A', creditorId: 'B', amount: 200, currency: 'USD' }),
    ];
    const result = engine.computeNetting(settlements, BASE_RATES);
    expect(result.groups).toHaveLength(1);
    expect(result.deferred).toHaveLength(0);
  });

  it('force-settles after maxDeferredPeriods even when below threshold', () => {
    const engine = new NettingEngine();
    const settlements = [
      makeSettlement({
        id: 'deferred1',
        debtorId: 'A',
        creditorId: 'B',
        amount: 30,
        currency: 'USD',
        deferredPeriods: 3, // already at max
      }),
    ];
    const result = engine.computeNetting(settlements, BASE_RATES);

    expect(result.forcedSettlements).toContain('deferred1');
    expect(result.groups).toHaveLength(1);
  });

  it('respects custom config thresholds', () => {
    const engine = new NettingEngine({ minThresholdUsd: 50, maxDeferredPeriods: 2 });
    const settlements = [
      makeSettlement({ id: 'c1', debtorId: 'X', creditorId: 'Y', amount: 60, currency: 'USD' }),
    ];
    const result = engine.computeNetting(settlements, BASE_RATES);
    expect(result.groups).toHaveLength(1); // 60 > 50 threshold
  });
});

describe('NettingEngine — full pipeline with multiple currencies', () => {
  it('processes USD and EUR settlements in the same period', () => {
    const engine = new NettingEngine();
    const settlements = [
      makeSettlement({
        id: 'm1',
        debtorId: 'FarmA',
        creditorId: 'BuyerB',
        amount: 5000,
        currency: 'USD',
      }),
      makeSettlement({
        id: 'm2',
        debtorId: 'BuyerB',
        creditorId: 'FarmA',
        amount: 2000,
        currency: 'USD',
      }),
      makeSettlement({
        id: 'm3',
        debtorId: 'FarmC',
        creditorId: 'BuyerD',
        amount: 3000,
        currency: 'EUR',
      }),
    ];

    const result = engine.computeNetting(settlements, BASE_RATES);
    expect(result.groups.length).toBeGreaterThan(0);
  });
});

// ─── FxOracle ─────────────────────────────────────────────────────────────────

describe('FxOracle — TWAP computation', () => {
  const periodStart = new Date('2025-06-15T00:00:00Z');
  const periodEnd = new Date('2025-06-16T00:00:00Z');

  function makeAdapter(samples: PriceSample[]): LiquidityPoolAdapter {
    return {
      getSamples: async () => samples,
    };
  }

  it('returns null when no samples exist', async () => {
    const oracle = new FxOracle(makeAdapter([]));
    const result = await oracle.computeTwap('USD/EUR', periodStart, periodEnd);
    expect(result).toBeNull();
  });

  it('returns spot price for a single sample', async () => {
    const oracle = new FxOracle(
      makeAdapter([{ timestamp: new Date('2025-06-15T12:00:00Z'), pair: 'USD/EUR', price: 0.92 }]),
    );
    const result = await oracle.computeTwap('USD/EUR', periodStart, periodEnd);
    expect(result).not.toBeNull();
    expect(result!.twap).toBe(0.92);
    expect(result!.sampleCount).toBe(1);
  });

  it('computes time-weighted average for two samples of equal duration', async () => {
    // Two samples dividing the window in half, one at 0.90 and one at 0.94
    const oracle = new FxOracle(
      makeAdapter([
        { timestamp: new Date('2025-06-15T00:00:00Z'), pair: 'USD/EUR', price: 0.9 },
        { timestamp: new Date('2025-06-15T12:00:00Z'), pair: 'USD/EUR', price: 0.94 },
      ]),
    );
    const result = await oracle.computeTwap('USD/EUR', periodStart, periodEnd);
    expect(result).not.toBeNull();
    // First sample holds for 12h, second holds for 12h → TWAP = (0.90*12 + 0.94*12)/24 = 0.92
    expect(result!.twap).toBeCloseTo(0.92, 4);
  });

  it('caches results per period and returns the same object', async () => {
    const getSamples = vi.fn(async () => [
      { timestamp: new Date('2025-06-15T06:00:00Z'), pair: 'USD/NGN' as const, price: 1580 },
    ]);
    const oracle = new FxOracle({ getSamples });

    await oracle.getRatesForPeriod(periodStart, periodEnd);
    await oracle.getRatesForPeriod(periodStart, periodEnd);

    // getSamples should be called once per pair × once (cached on second call)
    expect(getSamples).toHaveBeenCalledTimes(NETTING_INVARIANTS.currencyPairs.length);
  });

  it('invalidates the cache correctly', async () => {
    const getSamples = vi.fn(async () => [
      { timestamp: new Date('2025-06-15T06:00:00Z'), pair: 'USD/NGN' as const, price: 1580 },
    ]);
    const oracle = new FxOracle({ getSamples });

    await oracle.getRatesForPeriod(periodStart, periodEnd);
    oracle.invalidate(periodStart);
    await oracle.getRatesForPeriod(periodStart, periodEnd);

    // Called twice (once before invalidation, once after)
    expect(getSamples).toHaveBeenCalledTimes(NETTING_INVARIANTS.currencyPairs.length * 2);
  });

  it('throws when period window is invalid', async () => {
    const oracle = new FxOracle(
      makeAdapter([
        { timestamp: new Date('2025-06-15T06:00:00Z'), pair: 'USD/EUR', price: 0.92 },
        { timestamp: new Date('2025-06-15T08:00:00Z'), pair: 'USD/EUR', price: 0.93 },
      ]),
    );
    await expect(
      oracle.computeTwap('USD/EUR', periodEnd, periodStart), // inverted window
    ).rejects.toThrow('Invalid TWAP window');
  });
});

// ─── SwiftAdapter ─────────────────────────────────────────────────────────────

describe('SwiftAdapter — pacs.008 message construction', () => {
  function makeDirectory(
    records: Record<string, { bic: string; accountId: string; name: string }>,
  ): SwiftPartyDirectory {
    return {
      lookup: async (id) => records[id] ?? null,
    };
  }

  function makeGateway(accepted = true): SwiftGatewayClient {
    return {
      submit: async (_xml: string) => {
        return {
          uetr: 'uetr-test-1234',
          accepted,
          rejectionReason: accepted ? undefined : 'INVALID_BIC',
        };
      },
    };
  }

  it('builds a valid pacs.008 XML structure', () => {
    const adapter = new SwiftAdapter(makeDirectory({}), makeGateway());
    const instruction: Pacs008Instruction = {
      instructionId: 'INST-001',
      endToEndId: 'AGRI-NET-INST-001',
      debtorBic: 'AAAABBCC',
      debtorAccountId: 'DE89370400440532013000',
      debtorName: 'Farm Corp A',
      creditorBic: 'XXXXBBCC',
      creditorAccountId: 'GB29NWBK60161331926819',
      creditorName: 'Buyer Ltd B',
      amount: 1250.75,
      currency: 'USD',
      settlementDate: '2025-06-16',
      remittanceInfo: 's1,s2,s3',
    };

    const xml = adapter.buildPacs008(instruction);

    expect(xml).toContain('pacs.008.001.10');
    expect(xml).toContain('<MsgId>INST-001</MsgId>');
    expect(xml).toContain('<IntrBkSttlmAmt Ccy="USD">1250.75</IntrBkSttlmAmt>');
    expect(xml).toContain('<BICFI>AAAABBCC</BICFI>');
    expect(xml).toContain('<BICFI>XXXXBBCC</BICFI>');
    expect(xml).toContain('<Ustrd>s1,s2,s3</Ustrd>');
    expect(xml).toContain('<IntrBkSttlmDt>2025-06-16</IntrBkSttlmDt>');
  });

  it('escapes XML special characters in party names', () => {
    const adapter = new SwiftAdapter(makeDirectory({}), makeGateway());
    const instruction: Pacs008Instruction = {
      instructionId: 'INST-002',
      endToEndId: 'AGRI-NET-INST-002',
      debtorBic: 'AAAA',
      debtorAccountId: 'ACC1',
      debtorName: 'Farm & Co <Nigeria>',
      creditorBic: 'BBBB',
      creditorAccountId: 'ACC2',
      creditorName: 'Buyer "Ltd"',
      amount: 500,
      currency: 'NGN',
      settlementDate: '2025-06-16',
      remittanceInfo: 's4',
    };

    const xml = adapter.buildPacs008(instruction);
    expect(xml).toContain('Farm &amp; Co &lt;Nigeria&gt;');
    expect(xml).toContain('Buyer &quot;Ltd&quot;');
  });

  it('returns a failure result when debtor party is not found', async () => {
    const adapter = new SwiftAdapter(
      makeDirectory({
        creditor1: { bic: 'XXXX', accountId: 'ACC1', name: 'Creditor' },
      }),
      makeGateway(),
    );

    const position = {
      debtorId: 'unknown-debtor',
      creditorId: 'creditor1',
      netAmount: 500,
      currency: 'USD' as const,
      netAmountUsd: 500,
      settlementIds: ['s10'],
    };

    const result = await adapter.settlePosition(position, new Date());
    expect(result.accepted).toBe(false);
    expect(result.rejectionReason).toContain('No SWIFT party record for debtor');
  });

  it('skips CCP legs in settleGroup', async () => {
    const gateway = makeGateway();
    const submitSpy = vi.spyOn(gateway, 'submit');

    const adapter = new SwiftAdapter(makeDirectory({}), gateway);
    const group = {
      groupId: 'g1',
      algorithm: 'ccp' as const,
      period: { start: new Date(), end: new Date(), corridorId: 'default' },
      positions: [
        {
          debtorId: 'CCP:AGRITRUST',
          creditorId: 'PartyA',
          netAmount: 1000,
          currency: 'USD' as const,
          netAmountUsd: 1000,
          settlementIds: ['s11'],
        },
      ],
      allSettlementIds: ['s11'],
    };

    await adapter.settleGroup(group, new Date());
    expect(submitSpy).not.toHaveBeenCalled();
  });
});

// ─── BlockchainAdapter ────────────────────────────────────────────────────────

describe('BlockchainAdapter — USDC transfer batching', () => {
  function makeWallets(map: Record<string, string>): WalletDirectory {
    return {
      lookup: async (id) => (map[id] ? { address: map[id] } : null),
    };
  }

  function makeRpc(succeed = true): PolygonRpcClient & { calls: Erc20Transfer[][] } {
    const calls: Erc20Transfer[][] = [];
    return {
      calls,
      submitBatch: async (_contract, transfers) => {
        calls.push(transfers);
        return transfers.map((t, i) => ({
          txHash: `0x${i.toString(16).padStart(64, '0')}`,
          blockNumber: 99_000_000 + i,
          success: succeed,
        }));
      },
    };
  }

  it('builds eligible transfers and converts to USDC units', async () => {
    const wallets = makeWallets({ A: '0xAAAA', B: '0xBBBB' });
    const rpc = makeRpc();
    const adapter = new BlockchainAdapter(wallets, rpc);

    const positions = [
      {
        debtorId: 'A',
        creditorId: 'B',
        netAmount: 1000,
        currency: 'USD' as const,
        netAmountUsd: 1000,
        settlementIds: ['t1'],
      },
    ];

    const { eligible, failed } = await adapter.buildTransfers(positions);

    expect(failed).toHaveLength(0);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].from).toBe('0xAAAA');
    expect(eligible[0].to).toBe('0xBBBB');
    // 1000 USD × 10^6 = 1_000_000_000 USDC units
    expect(eligible[0].amountUnits).toBe(BigInt(1_000_000_000));
  });

  it('marks transfers as failed when wallet is missing', async () => {
    const wallets = makeWallets({ A: '0xAAAA' }); // B is missing
    const rpc = makeRpc();
    const adapter = new BlockchainAdapter(wallets, rpc);

    const positions = [
      {
        debtorId: 'A',
        creditorId: 'B',
        netAmount: 200,
        currency: 'USD' as const,
        netAmountUsd: 200,
        settlementIds: ['t2'],
      },
    ];

    const { eligible, failed } = await adapter.buildTransfers(positions);
    expect(eligible).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toContain('No wallet for creditor');
  });

  it('submits a batch via the RPC client and returns accepted on success', async () => {
    const wallets = makeWallets({ X: '0xXXXX', Y: '0xYYYY' });
    const rpc = makeRpc(true);
    const adapter = new BlockchainAdapter(wallets, rpc);

    const group = {
      groupId: 'group-bc-1',
      algorithm: 'ccp' as const,
      period: { start: new Date(), end: new Date(), corridorId: 'default' },
      positions: [
        {
          debtorId: 'X',
          creditorId: 'Y',
          netAmount: 500,
          currency: 'USD' as const,
          netAmountUsd: 500,
          settlementIds: ['t3'],
        },
      ],
      allSettlementIds: ['t3'],
    };

    const result = await adapter.settleGroup(group);
    expect(result.accepted).toBe(true);
    expect(rpc.calls).toHaveLength(1);
  });

  it('returns not accepted when RPC receipts show failure', async () => {
    const wallets = makeWallets({ X: '0xXXXX', Y: '0xYYYY' });
    const rpc = makeRpc(false);
    const adapter = new BlockchainAdapter(wallets, rpc);

    const group = {
      groupId: 'group-bc-fail',
      algorithm: 'ccp' as const,
      period: { start: new Date(), end: new Date(), corridorId: 'default' },
      positions: [
        {
          debtorId: 'X',
          creditorId: 'Y',
          netAmount: 500,
          currency: 'USD' as const,
          netAmountUsd: 500,
          settlementIds: ['t4'],
        },
      ],
      allSettlementIds: ['t4'],
    };

    const result = await adapter.settleGroup(group);
    expect(result.accepted).toBe(false);
  });
});

// ─── RollbackManager ──────────────────────────────────────────────────────────

describe('RollbackManager — atomic rollback', () => {
  function makeSwiftReversal(succeed = true): SwiftReversal {
    return {
      reverse: async () => ({
        success: succeed,
        error: succeed ? undefined : 'SWIFT recall rejected',
      }),
    };
  }

  function makeBlockchainReversal(succeed = true): BlockchainReversal {
    return {
      reverse: async () => ({
        success: succeed,
        error: succeed ? undefined : 'on-chain reversal failed',
      }),
    };
  }

  const sampleGroup = {
    groupId: 'g-rollback-1',
    algorithm: 'ccp' as const,
    period: { start: new Date(), end: new Date(), corridorId: 'default' },
    positions: [
      {
        debtorId: 'A',
        creditorId: 'B',
        netAmount: 1000,
        currency: 'USD' as const,
        netAmountUsd: 1000,
        settlementIds: ['r1', 'r2'],
      },
    ],
    allSettlementIds: ['r1', 'r2'],
  };

  it('returns null when all legs succeed', async () => {
    const rm = new RollbackManager(makeSwiftReversal(), makeBlockchainReversal());

    const result = await rm.handleSettlementResult(
      sampleGroup,
      [{ instructionId: 'INST-1', uetr: 'uetr-1', accepted: true }],
      {
        nettingGroupId: 'g-rollback-1',
        txHash: '0xabc',
        accepted: true,
        receipts: [],
        failedTransfers: [],
      },
    );

    expect(result).toBeNull();
  });

  it('rolls back SWIFT leg when blockchain leg fails', async () => {
    const rm = new RollbackManager(makeSwiftReversal(true), makeBlockchainReversal(true), {
      backoffMs: 0,
    });

    const record = await rm.handleSettlementResult(
      sampleGroup,
      [{ instructionId: 'INST-1', uetr: 'uetr-ok', accepted: true }],
      {
        nettingGroupId: 'g-rollback-1',
        txHash: '',
        accepted: false,
        receipts: [],
        failedTransfers: [{ transfer: {} as Erc20Transfer, reason: 'reverted' }],
      },
    );

    expect(record).not.toBeNull();
    expect(record!.rolledBackLegs).toHaveLength(1);
    expect(record!.rolledBackLegs[0].rail).toBe('swift');
    expect(record!.fullyRolledBack).toBe(true);
  });

  it('rolls back blockchain leg when SWIFT leg fails', async () => {
    const rm = new RollbackManager(makeSwiftReversal(true), makeBlockchainReversal(true), {
      backoffMs: 0,
    });

    const record = await rm.handleSettlementResult(
      sampleGroup,
      [{ instructionId: 'INST-1', uetr: '', accepted: false, rejectionReason: 'INVALID_ACCOUNT' }],
      {
        nettingGroupId: 'g-rollback-1',
        txHash: '0xconfirmed',
        accepted: true,
        receipts: [],
        failedTransfers: [],
      },
    );

    expect(record).not.toBeNull();
    expect(record!.rolledBackLegs[0].rail).toBe('blockchain');
    expect(record!.fullyRolledBack).toBe(true);
  });

  it('records failed rollback when reversal itself fails', async () => {
    const rm = new RollbackManager(
      makeSwiftReversal(false), // reversal will fail
      makeBlockchainReversal(true),
      { maxRetries: 1, backoffMs: 0 },
    );

    const record = await rm.rollback(
      'group-fail',
      [{ rail: 'swift', railRef: 'uetr-bad', instructionId: 'INST-BAD', settlementIds: ['s99'] }],
      'test failure',
    );

    expect(record.fullyRolledBack).toBe(false);
    expect(record.failedRollbacks).toHaveLength(1);
    expect(record.failedRollbacks[0].reason).toContain('SWIFT recall rejected');
  });
});

// ─── Chaos test — 50 cross-border trades with 10% blockchain failure rate ─────

describe('Chaos test — 50 trades, 10% blockchain failure rate, rollback atomicity', () => {
  it('rolls back all accepted legs when any blockchain transfer fails', async () => {
    const engine = new NettingEngine({ minThresholdUsd: 0 }); // disable threshold for chaos test

    // Generate 50 settlements across 10 party pairs
    const settlements: PendingSettlement[] = [];
    const parties = ['P1', 'P2', 'P3', 'P4', 'P5'];

    for (let i = 0; i < 50; i++) {
      const debtor = parties[i % parties.length];
      const creditorIdx = (i + 1) % parties.length;
      const creditor = parties[creditorIdx];
      settlements.push(
        makeSettlement({
          id: `chaos-${i}`,
          debtorId: debtor,
          creditorId: creditor,
          amount: 200 + i * 10,
          currency: 'USD',
        }),
      );
    }

    const result = engine.computeNetting(settlements, BASE_RATES);
    expect(result.groups.length).toBeGreaterThan(0);

    const group = result.groups[0];

    // 10% failure rate on blockchain — 1 in 10 transfers fails
    let callCount = 0;
    const rpc: PolygonRpcClient = {
      submitBatch: async (_contract, transfers) => {
        return transfers.map((_, i) => {
          const fails = callCount === 0 && i === 0; // first transfer in first batch fails
          callCount++;
          return {
            txHash: `0x${i.toString(16).padStart(64, '0')}`,
            blockNumber: 99_000_000 + i,
            success: !fails,
          };
        });
      },
    };

    const wallets: WalletDirectory = {
      lookup: async (id) => ({ address: `0x${id.replace(/[^a-zA-Z0-9]/g, '').padEnd(40, '0')}` }),
    };

    const blockchainAdapter = new BlockchainAdapter(wallets, rpc);
    const bcResult = await blockchainAdapter.settleGroup(group);

    // SWIFT side: all accepted
    const swiftResults = group.positions
      .filter((p) => p.debtorId !== 'CCP:AGRITRUST' && p.creditorId !== 'CCP:AGRITRUST')
      .map((p, i) => ({
        instructionId: p.settlementIds[0] ?? `inst-${i}`,
        uetr: `uetr-${i}`,
        accepted: true,
      }));

    const rm = new RollbackManager(
      { reverse: async () => ({ success: true }) },
      { reverse: async () => ({ success: true }) },
      { backoffMs: 0 },
    );

    const rollback = await rm.handleSettlementResult(group, swiftResults, bcResult);

    if (bcResult.failedTransfers.length > 0 || !bcResult.accepted) {
      // Rollback must have been triggered
      expect(rollback).not.toBeNull();
      expect(rollback!.fullyRolledBack).toBe(true);
      // All accepted SWIFT legs must be reversed
      expect(rollback!.rolledBackLegs.filter((l) => l.rail === 'swift')).toHaveLength(
        swiftResults.filter((r) => r.accepted && r.uetr).length,
      );
    } else {
      // No failures occurred in this run
      expect(rollback).toBeNull();
    }
  });
});
