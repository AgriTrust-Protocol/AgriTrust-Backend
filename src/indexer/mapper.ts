import { createHash } from 'crypto';
import { DomainEvent, RawChainEvent } from './types';

const EVENT_TYPE: Record<string, DomainEvent['type']> = {
  YieldPublished: 'yield_published',
  CropYieldPublished: 'yield_published',
  SettlementExecuted: 'settlement_executed',
  ProvenanceUpdated: 'provenance_updated',
  InsuranceClaimed: 'insurance_claimed',
};

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing ${key}`);
  return value;
}

export function mapRawEvent(raw: RawChainEvent): DomainEvent | undefined {
  const type = EVENT_TYPE[raw.eventName];
  if (!type) return undefined;
  const occurredAtValue = raw.payload.occurred_at ?? raw.payload.occurredAt;
  const occurredAt = typeof occurredAtValue === 'string' || typeof occurredAtValue === 'number'
    ? new Date(occurredAtValue)
    : raw.observedAt ?? new Date();
  const eventKey = `${raw.chain}:${raw.transactionHash}:${raw.logIndex}`;
  return {
    id: createHash('sha256').update(eventKey).digest('hex'),
    chain: raw.chain,
    blockNumber: raw.blockNumber,
    blockHash: raw.blockHash,
    transactionHash: raw.transactionHash,
    logIndex: raw.logIndex,
    type,
    farmId: requiredString(raw.payload, 'farm_id'),
    season: typeof raw.payload.season === 'string' ? raw.payload.season : undefined,
    occurredAt,
    data: raw.payload,
  };
}
