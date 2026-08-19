/**
 * Multi-Currency Netting Engine
 *
 * Implements bilateral netting → multilateral netting → central counterparty
 * netting for cross-border agricultural trade settlements. Aggregates all
 * pending settlements over a 24-hour netting period (configurable per trading
 * corridor), computes net positions per currency pair, and defers settlements
 * below the minimum threshold (with a maximum deferral cap).
 */

export type SupportedCurrency = 'USD' | 'EUR' | 'NGN' | 'KES';

export type CurrencyPair =
  | 'USD/EUR'
  | 'USD/NGN'
  | 'USD/KES'
  | 'EUR/NGN'
  | 'EUR/KES';

export type NettingAlgorithm = 'bilateral' | 'multilateral' | 'ccp';

/** Technical invariants from the feature spec. */
export const NETTING_INVARIANTS = {
  /** Default netting period in hours (midnight UTC boundary). */
  periodHours: 24,
  /** Supported FX currency pairs. */
  currencyPairs: ['USD/EUR', 'USD/NGN', 'USD/KES', 'EUR/NGN', 'EUR/KES'] as CurrencyPair[],
  /** Minimum net USD-equivalent to trigger settlement in a period. */
  minThresholdUsd: 100,
  /** Maximum consecutive deferred periods before forced settlement. */
  maxDeferredPeriods: 3,
} as const;

export interface PendingSettlement {
  id: string;
  /** Party that owes funds. */
  debtorId: string;
  /** Party that receives funds. */
  creditorId: string;
  amount: number;
  currency: SupportedCurrency;
  /** ISO 8601 trade timestamp; used to assign to a netting period. */
  tradeTimestamp: Date;
  /** Trading corridor identifier (used to select netting period config). */
  corridorId?: string;
  /** Number of periods this settlement has already been deferred. */
  deferredPeriods?: number;
}

export interface NetPosition {
  debtorId: string;
  creditorId: string;
  netAmount: number;
  currency: SupportedCurrency;
  /** USD-equivalent net amount at the TWAP rate for the period. */
  netAmountUsd: number;
  /** Settlement IDs included in this net position. */
  settlementIds: string[];
}

export interface NettingGroup {
  groupId: string;
  algorithm: NettingAlgorithm;
  period: NettingPeriod;
  positions: NetPosition[];
  /** All constituent settlement IDs — used for atomic rollback. */
  allSettlementIds: string[];
}

export interface NettingPeriod {
  /** Period start (midnight UTC). */
  start: Date;
  /** Period end (exclusive). */
  end: Date;
  corridorId: string;
}

export interface DeferralRecord {
  settlementId: string;
  deferredPeriods: number;
  /** True when forced through after maxDeferredPeriods. */
  forced: boolean;
}

export interface NettingResult {
  period: NettingPeriod;
  groups: NettingGroup[];
  deferred: DeferralRecord[];
  forcedSettlements: string[];
}

/** FX rates keyed by CurrencyPair (e.g. 'USD/EUR'). */
export type FxRates = Partial<Record<CurrencyPair, number>>;

export interface NettingConfig {
  /** Override the netting period hours (default: 24). */
  periodHours?: number;
  /** Minimum net USD-equivalent threshold (default: 100). */
  minThresholdUsd?: number;
  /** Maximum deferred periods before forced settlement (default: 3). */
  maxDeferredPeriods?: number;
}

/**
 * Converts an amount in `from` currency to USD using the provided FX rates.
 * Rates are stored as `from/to` pairs with the base as the first symbol.
 */
function toUsd(amount: number, currency: SupportedCurrency, rates: FxRates): number {
  if (currency === 'USD') return amount;

  const directPair = `USD/${currency}` as CurrencyPair;
  const inversePair = `${currency}/USD` as CurrencyPair;

  if (rates[directPair] !== undefined && rates[directPair]! > 0) {
    // USD/NGN = 1500 means 1 USD = 1500 NGN → NGN to USD = amount / 1500
    return amount / rates[directPair]!;
  }
  if (rates[inversePair] !== undefined && rates[inversePair]! > 0) {
    return amount * rates[inversePair]!;
  }

  // Cross-rate through USD: currency → USD via the pairs table
  // e.g. EUR → USD: look for EUR/USD or 1/(USD/EUR)
  const eurUsd = rates['USD/EUR'];
  if (currency === 'EUR' && eurUsd !== undefined && eurUsd > 0) {
    return amount / eurUsd; // USD/EUR means how many EUR per USD; EUR→USD = amount/rate
  }

  throw new Error(`No FX rate available to convert ${currency} to USD`);
}

/**
 * Determines the netting period bucket (midnight UTC boundaries) for a trade
 * timestamp.
 */
function periodForTimestamp(ts: Date, corridorId: string): NettingPeriod {
  const start = new Date(ts);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end, corridorId };
}

/**
 * Generates a stable group ID from debtor/creditor pair and period.
 */
function groupId(debtorId: string, creditorId: string, period: NettingPeriod): string {
  return `${period.start.toISOString()}|${[debtorId, creditorId].sort().join('|')}`;
}

/**
 * NettingEngine — computes net positions for a set of pending settlements.
 *
 * Pipeline:
 *  1. Assign each settlement to a netting period.
 *  2. Apply bilateral netting: for each (debtor, creditor, currency) triple,
 *     compute the net direction and amount.
 *  3. Apply multilateral netting: for each party, offset receivables against
 *     payables across all counterparties to reduce the number of transfers.
 *  4. Apply CCP netting: centralise residual positions through a single CCP
 *     node, further reducing bilateral transfers.
 *  5. Apply threshold deferral: skip nets below minThresholdUsd, increment
 *     deferredPeriods; force settlement after maxDeferredPeriods.
 */
export class NettingEngine {
  private readonly periodHours: number;
  private readonly minThresholdUsd: number;
  private readonly maxDeferredPeriods: number;

  constructor(config: NettingConfig = {}) {
    this.periodHours = config.periodHours ?? NETTING_INVARIANTS.periodHours;
    this.minThresholdUsd = config.minThresholdUsd ?? NETTING_INVARIANTS.minThresholdUsd;
    this.maxDeferredPeriods = config.maxDeferredPeriods ?? NETTING_INVARIANTS.maxDeferredPeriods;
  }

  /**
   * Entry point: run the full netting pipeline for a batch of pending
   * settlements and the TWAP FX rates for the period.
   */
  computeNetting(
    settlements: PendingSettlement[],
    fxRates: FxRates,
  ): NettingResult {
    if (settlements.length === 0) {
      return {
        period: periodForTimestamp(new Date(), 'default'),
        groups: [],
        deferred: [],
        forcedSettlements: [],
      };
    }

    // Group settlements by corridor/period bucket
    const byPeriod = this.groupByPeriod(settlements);
    const allGroups: NettingGroup[] = [];
    const allDeferred: DeferralRecord[] = [];
    const forcedSettlements: string[] = [];

    for (const [, { period, items }] of byPeriod) {
      // Step 1: bilateral netting
      const bilateralPositions = this.bilateralNetting(items, fxRates);

      // Step 2: multilateral netting
      const multilateralPositions = this.multilateralNetting(bilateralPositions, fxRates);

      // Step 3: CCP netting
      const ccpPositions = this.ccpNetting(multilateralPositions, fxRates);

      // Step 4: threshold and deferral logic
      const { settled, deferred, forced } = this.applyThreshold(
        ccpPositions,
        items,
        fxRates,
      );

      allDeferred.push(...deferred);
      forcedSettlements.push(...forced);

      if (settled.length > 0) {
        const allIds = settled.flatMap((p) => p.settlementIds);
        allGroups.push({
          groupId: groupId(
            settled[0].debtorId,
            settled[0].creditorId,
            period,
          ),
          algorithm: 'ccp',
          period,
          positions: settled,
          allSettlementIds: allIds,
        });
      }
    }

    const firstPeriod = byPeriod.values().next().value?.period
      ?? periodForTimestamp(new Date(), 'default');

    return {
      period: firstPeriod,
      groups: allGroups,
      deferred: allDeferred,
      forcedSettlements,
    };
  }

  // ── Step 1: Bilateral netting ─────────────────────────────────────────────

  /**
   * For each (debtor, creditor, currency) triple, nets all flows in both
   * directions to produce a single net payable. If A owes B 100 USD and B owes
   * A 40 USD, the net is: A owes B 60 USD.
   */
  bilateralNetting(
    settlements: PendingSettlement[],
    fxRates: FxRates,
  ): NetPosition[] {
    // Key: `sortedPartyA|sortedPartyB|currency`
    type BilateralKey = string;
    const ledger = new Map<
      BilateralKey,
      { partyA: string; partyB: string; currency: SupportedCurrency; netA: number; ids: string[] }
    >();

    for (const s of settlements) {
      const [partyA, partyB] = [s.debtorId, s.creditorId].sort();
      const key: BilateralKey = `${partyA}|${partyB}|${s.currency}`;

      if (!ledger.has(key)) {
        ledger.set(key, { partyA, partyB, currency: s.currency, netA: 0, ids: [] });
      }

      const entry = ledger.get(key)!;
      entry.ids.push(s.id);

      // Positive netA means partyA owes partyB
      if (s.debtorId === partyA) {
        entry.netA += s.amount;
      } else {
        entry.netA -= s.amount;
      }
    }

    const positions: NetPosition[] = [];
    for (const entry of ledger.values()) {
      if (entry.netA === 0) continue;

      const debtor = entry.netA > 0 ? entry.partyA : entry.partyB;
      const creditor = entry.netA > 0 ? entry.partyB : entry.partyA;
      const netAmount = Math.abs(entry.netA);
      const netAmountUsd = toUsd(netAmount, entry.currency, fxRates);

      positions.push({
        debtorId: debtor,
        creditorId: creditor,
        netAmount,
        currency: entry.currency,
        netAmountUsd,
        settlementIds: [...entry.ids],
      });
    }

    return positions;
  }

  // ── Step 2: Multilateral netting ─────────────────────────────────────────

  /**
   * For each currency, constructs a net balance sheet per party and reduces
   * the number of bilateral transfers by routing offsetting flows through
   * a single settlement instruction per net creditor/debtor pair.
   */
  multilateralNetting(
    positions: NetPosition[],
    fxRates: FxRates,
  ): NetPosition[] {
    // Group by currency
    const byCurrency = new Map<SupportedCurrency, NetPosition[]>();
    for (const p of positions) {
      if (!byCurrency.has(p.currency)) byCurrency.set(p.currency, []);
      byCurrency.get(p.currency)!.push(p);
    }

    const result: NetPosition[] = [];

    for (const [currency, cPositions] of byCurrency) {
      // Compute net balance for each party in this currency
      const balances = new Map<string, { balance: number; ids: string[] }>();

      for (const p of cPositions) {
        if (!balances.has(p.debtorId)) balances.set(p.debtorId, { balance: 0, ids: [] });
        if (!balances.has(p.creditorId)) balances.set(p.creditorId, { balance: 0, ids: [] });

        balances.get(p.debtorId)!.balance -= p.netAmount;
        balances.get(p.debtorId)!.ids.push(...p.settlementIds);
        balances.get(p.creditorId)!.balance += p.netAmount;
        balances.get(p.creditorId)!.ids.push(...p.settlementIds);
      }

      // Separate net debtors (negative balance) and net creditors (positive)
      const debtors: Array<{ id: string; amount: number; ids: string[] }> = [];
      const creditors: Array<{ id: string; amount: number; ids: string[] }> = [];

      for (const [partyId, entry] of balances) {
        if (entry.balance < 0) {
          debtors.push({ id: partyId, amount: -entry.balance, ids: entry.ids });
        } else if (entry.balance > 0) {
          creditors.push({ id: partyId, amount: entry.balance, ids: entry.ids });
        }
      }

      // Match debtors to creditors greedily
      const netted = this.matchDebtorsToCreditors(debtors, creditors, currency, fxRates);
      result.push(...netted);
    }

    return result;
  }

  // ── Step 3: CCP netting ───────────────────────────────────────────────────

  /**
   * Routes all remaining net positions through a Central Counterparty (CCP)
   * node. Each net debtor pays the CCP; the CCP pays each net creditor.
   * This reduces N*(N-1)/2 bilateral links to 2*N CCP links.
   */
  ccpNetting(
    positions: NetPosition[],
    fxRates: FxRates,
  ): NetPosition[] {
    const CCP_ID = 'CCP:AGRITRUST';

    const byCurrency = new Map<SupportedCurrency, NetPosition[]>();
    for (const p of positions) {
      if (!byCurrency.has(p.currency)) byCurrency.set(p.currency, []);
      byCurrency.get(p.currency)!.push(p);
    }

    const result: NetPosition[] = [];

    for (const [currency, cPositions] of byCurrency) {
      const balances = new Map<string, { balance: number; ids: string[] }>();

      for (const p of cPositions) {
        if (!balances.has(p.debtorId)) balances.set(p.debtorId, { balance: 0, ids: [] });
        if (!balances.has(p.creditorId)) balances.set(p.creditorId, { balance: 0, ids: [] });

        balances.get(p.debtorId)!.balance -= p.netAmount;
        balances.get(p.debtorId)!.ids.push(...p.settlementIds);
        balances.get(p.creditorId)!.balance += p.netAmount;
        balances.get(p.creditorId)!.ids.push(...p.settlementIds);
      }

      for (const [partyId, { balance, ids }] of balances) {
        if (Math.abs(balance) < 1e-9) continue;

        const netAmount = Math.abs(balance);
        const netAmountUsd = toUsd(netAmount, currency, fxRates);

        if (balance < 0) {
          // Party is net debtor → pays CCP
          result.push({
            debtorId: partyId,
            creditorId: CCP_ID,
            netAmount,
            currency,
            netAmountUsd,
            settlementIds: [...ids],
          });
        } else {
          // Party is net creditor → receives from CCP
          result.push({
            debtorId: CCP_ID,
            creditorId: partyId,
            netAmount,
            currency,
            netAmountUsd,
            settlementIds: [...ids],
          });
        }
      }
    }

    return result;
  }

  // ── Step 4: Threshold deferral ────────────────────────────────────────────

  /**
   * Applies the minimum threshold and deferral logic:
   * - Nets below minThresholdUsd are deferred (deferredPeriods + 1).
   * - Nets deferred >= maxDeferredPeriods are force-settled.
   */
  private applyThreshold(
    positions: NetPosition[],
    originalSettlements: PendingSettlement[],
    _fxRates: FxRates,
  ): { settled: NetPosition[]; deferred: DeferralRecord[]; forced: string[] } {
    const settled: NetPosition[] = [];
    const deferred: DeferralRecord[] = [];
    const forced: string[] = [];

    // Build a quick lookup: settlementId → deferredPeriods
    const deferralLookup = new Map<string, number>();
    for (const s of originalSettlements) {
      deferralLookup.set(s.id, s.deferredPeriods ?? 0);
    }

    for (const pos of positions) {
      if (pos.netAmountUsd >= this.minThresholdUsd) {
        settled.push(pos);
        continue;
      }

      // Below threshold — check max deferral
      const maxDeferred = pos.settlementIds.reduce((max, id) => {
        return Math.max(max, deferralLookup.get(id) ?? 0);
      }, 0);

      if (maxDeferred >= this.maxDeferredPeriods) {
        // Force settlement: include in settled even though below threshold
        settled.push(pos);
        forced.push(...pos.settlementIds);
      } else {
        // Defer: record deferral for each constituent settlement
        for (const id of pos.settlementIds) {
          const current = deferralLookup.get(id) ?? 0;
          deferred.push({
            settlementId: id,
            deferredPeriods: current + 1,
            forced: false,
          });
        }
      }
    }

    return { settled, deferred, forced };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private groupByPeriod(settlements: PendingSettlement[]): Map<
    string,
    { period: NettingPeriod; items: PendingSettlement[] }
  > {
    const map = new Map<string, { period: NettingPeriod; items: PendingSettlement[] }>();

    for (const s of settlements) {
      const corridorId = s.corridorId ?? 'default';
      const period = periodForTimestamp(s.tradeTimestamp, corridorId);
      const key = `${period.start.toISOString()}|${corridorId}`;

      if (!map.has(key)) {
        map.set(key, { period, items: [] });
      }
      map.get(key)!.items.push(s);
    }

    return map;
  }

  private matchDebtorsToCreditors(
    debtors: Array<{ id: string; amount: number; ids: string[] }>,
    creditors: Array<{ id: string; amount: number; ids: string[] }>,
    currency: SupportedCurrency,
    fxRates: FxRates,
  ): NetPosition[] {
    const result: NetPosition[] = [];
    const dQueue = debtors.map((d) => ({ ...d }));
    const cQueue = creditors.map((c) => ({ ...c }));

    let di = 0;
    let ci = 0;

    while (di < dQueue.length && ci < cQueue.length) {
      const d = dQueue[di];
      const c = cQueue[ci];

      const matchAmount = Math.min(d.amount, c.amount);
      if (matchAmount > 1e-9) {
        result.push({
          debtorId: d.id,
          creditorId: c.id,
          netAmount: matchAmount,
          currency,
          netAmountUsd: toUsd(matchAmount, currency, fxRates),
          settlementIds: [...new Set([...d.ids, ...c.ids])],
        });
      }

      d.amount -= matchAmount;
      c.amount -= matchAmount;

      if (d.amount < 1e-9) di++;
      if (c.amount < 1e-9) ci++;
    }

    return result;
  }
}
