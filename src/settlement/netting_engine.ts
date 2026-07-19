import { Currency, CurrencyPair, FxOracle, NettingPeriod } from './fx_oracle';

export type SettlementRail = 'swift' | 'polygon_usdc';
export type SettlementStatus = 'pending' | 'deferred' | 'ready';

export interface SettlementTrade {
  id: string;
  corridorId: string;
  debtor: string;
  creditor: string;
  sourceCurrency: Currency;
  targetCurrency: Currency;
  sourceAmount: number;
  rail: SettlementRail;
  deferredPeriods?: number;
}

export interface NetSettlementInstruction {
  id: string;
  periodId: string;
  groupId: string;
  debtor: string;
  creditor: string;
  currency: Currency;
  amount: number;
  rail: SettlementRail;
  status: SettlementStatus;
  deferredPeriods: number;
  tradeIds: string[];
}

export interface NettingConfig {
  minUsdThreshold: number;
  maxDeferredPeriods: number;
}

const DEFAULT_CONFIG: NettingConfig = { minUsdThreshold: 100, maxDeferredPeriods: 3 };

function pairFor(from: Currency, to: Currency): CurrencyPair | null {
  const pair = `${from}/${to}` as CurrencyPair;
  if (['USD/EUR', 'USD/NGN', 'USD/KES', 'EUR/NGN', 'EUR/KES'].includes(pair)) return pair;
  return null;
}

export class MultiCurrencyNettingEngine {
  private readonly config: NettingConfig;

  constructor(private readonly fxOracle: FxOracle, config: Partial<NettingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  static defaultPeriod(now = new Date()): NettingPeriod {
    const startsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const endsAt = new Date(startsAt.getTime() + 24 * 60 * 60 * 1000);
    return { id: startsAt.toISOString().slice(0, 10), startsAt, endsAt };
  }

  async compute(period: NettingPeriod, trades: SettlementTrade[]): Promise<NetSettlementInstruction[]> {
    const normalized = await Promise.all(trades.map((trade) => this.normalizeTrade(trade, period)));
    const bilateral = this.netByKey(normalized, (leg) => `${leg.debtor}|${leg.creditor}|${leg.currency}|${leg.rail}`);
    const multilateral = this.netByParticipantCurrency(bilateral);
    return Promise.all(multilateral.map((leg, index) => this.toInstruction(period, leg, index)));
  }

  private async normalizeTrade(trade: SettlementTrade, period: NettingPeriod) {
    const pair = pairFor(trade.sourceCurrency, trade.targetCurrency);
    const inversePair = pairFor(trade.targetCurrency, trade.sourceCurrency);
    const amount = pair
      ? trade.sourceAmount * (await this.fxOracle.twap(pair, period))
      : inversePair
        ? trade.sourceAmount / (await this.fxOracle.twap(inversePair, period))
        : trade.sourceAmount;
    return { ...trade, currency: trade.targetCurrency, amount };
  }

  private netByKey<T extends { debtor: string; creditor: string; currency: Currency; rail: SettlementRail; amount: number; id: string; deferredPeriods?: number }>(
    legs: T[],
    keyFn: (leg: T) => string,
  ) {
    const map = new Map<string, T & { tradeIds: string[] }>();
    for (const leg of legs) {
      const reverseKey = `${leg.creditor}|${leg.debtor}|${leg.currency}|${leg.rail}`;
      const reverse = map.get(reverseKey);
      if (reverse) {
        reverse.amount -= leg.amount;
        reverse.tradeIds.push(leg.id);
      } else {
        const key = keyFn(leg);
        const current = map.get(key);
        if (current) {
          current.amount += leg.amount;
          current.tradeIds.push(leg.id);
        } else {
          map.set(key, { ...leg, tradeIds: [leg.id] });
        }
      }
    }
    return [...map.values()].filter((leg) => Math.abs(leg.amount) > 0.000001).map((leg) => leg.amount < 0 ? { ...leg, debtor: leg.creditor, creditor: leg.debtor, amount: Math.abs(leg.amount) } : leg);
  }

  private netByParticipantCurrency(legs: ReturnType<MultiCurrencyNettingEngine['netByKey']>) {
    const balances = new Map<string, { participant: string; currency: Currency; rail: SettlementRail; amount: number; tradeIds: string[]; deferredPeriods: number }>();
    for (const leg of legs) {
      for (const [participant, signed] of [[leg.debtor, -leg.amount], [leg.creditor, leg.amount]] as const) {
        const key = `${participant}|${leg.currency}|${leg.rail}`;
        const current = balances.get(key) ?? { participant, currency: leg.currency, rail: leg.rail, amount: 0, tradeIds: [], deferredPeriods: 0 };
        current.amount += signed;
        current.tradeIds.push(...leg.tradeIds);
        current.deferredPeriods = Math.max(current.deferredPeriods, leg.deferredPeriods ?? 0);
        balances.set(key, current);
      }
    }
    const debtors = [...balances.values()].filter((b) => b.amount < -0.000001);
    const creditors = [...balances.values()].filter((b) => b.amount > 0.000001);
    const out: Array<{ debtor: string; creditor: string; currency: Currency; rail: SettlementRail; amount: number; tradeIds: string[]; deferredPeriods: number }> = [];
    for (const debtor of debtors) for (const creditor of creditors.filter((c) => c.currency === debtor.currency && c.rail === debtor.rail)) {
      const amount = Math.min(-debtor.amount, creditor.amount);
      if (amount <= 0) continue;
      debtor.amount += amount; creditor.amount -= amount;
      out.push({ debtor: debtor.participant, creditor: creditor.participant, currency: debtor.currency, rail: debtor.rail, amount, tradeIds: [...new Set([...debtor.tradeIds, ...creditor.tradeIds])], deferredPeriods: Math.max(debtor.deferredPeriods, creditor.deferredPeriods) });
    }
    return out;
  }

  private async toInstruction(period: NettingPeriod, leg: { debtor: string; creditor: string; currency: Currency; rail: SettlementRail; amount: number; tradeIds: string[]; deferredPeriods: number }, index: number): Promise<NetSettlementInstruction> {
    const usdEquivalent = await this.toUsd(leg.currency, leg.amount, period);
    const status = usdEquivalent < this.config.minUsdThreshold && leg.deferredPeriods < this.config.maxDeferredPeriods ? 'deferred' : 'ready';
    return { id: `${period.id}-${index + 1}`, periodId: period.id, groupId: `${period.id}:${leg.currency}:${leg.rail}`, ...leg, status, deferredPeriods: status === 'deferred' ? leg.deferredPeriods + 1 : leg.deferredPeriods };
  }

  private async toUsd(currency: Currency, amount: number, period: NettingPeriod): Promise<number> {
    if (currency === 'USD') return amount;
    const inversePair = pairFor('USD', currency);
    if (inversePair) return amount / (await this.fxOracle.twap(inversePair, period));
    const eurPair = pairFor('EUR', currency);
    if (eurPair) {
      const usdEur = await this.fxOracle.twap('USD/EUR', period);
      return (amount / (await this.fxOracle.twap(eurPair, period))) / usdEur;
    }
    throw new Error(`No USD conversion path for ${currency}`);
  }
}
