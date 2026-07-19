import type { Pool, PoolClient } from 'pg';
import { DomainEvent, RawChainEvent } from './types';
import { mapRawEvent } from './mapper';

export type Queryable = Pick<Pool | PoolClient, 'query'>;

export class EventMaterializer {
  constructor(private readonly db: Queryable) {}

  async ingest(raw: RawChainEvent): Promise<DomainEvent | undefined> {
    const mapped = mapRawEvent(raw);
    await this.db.query(
      `INSERT INTO raw_events(chain, block_number, block_hash, transaction_hash, log_index, contract_address, event_name, payload, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (chain, transaction_hash, log_index) DO UPDATE SET block_number=EXCLUDED.block_number, block_hash=EXCLUDED.block_hash, payload=EXCLUDED.payload`,
      [raw.chain, raw.blockNumber, raw.blockHash, raw.transactionHash, raw.logIndex, raw.contractAddress, raw.eventName, raw.payload, raw.observedAt ?? new Date()],
    );
    if (!mapped) return undefined;
    await this.upsert(mapped);
    await this.db.query(
      `INSERT INTO indexer_cursors(chain, last_block, block_hash, updated_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (chain) DO UPDATE SET last_block=GREATEST(indexer_cursors.last_block, EXCLUDED.last_block), block_hash=EXCLUDED.block_hash, updated_at=NOW()`,
      [mapped.chain, mapped.blockNumber, mapped.blockHash],
    );
    return mapped;
  }

  private async upsert(event: DomainEvent): Promise<void> {
    if (event.type === 'yield_published') {
      await this.db.query(
        `INSERT INTO farm_yields(event_id, chain, farm_id, season, crop, quantity, unit, block_number, transaction_hash, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (event_id) DO UPDATE SET quantity=EXCLUDED.quantity, unit=EXCLUDED.unit`,
        [event.id, event.chain, event.farmId, event.season, event.data.crop, event.data.quantity, event.data.unit, event.blockNumber, event.transactionHash, event.occurredAt],
      );
    } else if (event.type === 'settlement_executed') {
      await this.db.query(
        `INSERT INTO settlements(event_id, chain, farm_id, season, amount, asset, counterparty, block_number, transaction_hash, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (event_id) DO UPDATE SET amount=EXCLUDED.amount`,
        [event.id, event.chain, event.farmId, event.season, event.data.amount, event.data.asset, event.data.counterparty, event.blockNumber, event.transactionHash, event.occurredAt],
      );
    } else if (event.type === 'provenance_updated') {
      await this.db.query(
        `INSERT INTO provenance_events(event_id, chain, farm_id, season, provenance_hash, metadata, block_number, transaction_hash, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (event_id) DO UPDATE SET metadata=EXCLUDED.metadata`,
        [event.id, event.chain, event.farmId, event.season, event.data.provenance_hash, event.data, event.blockNumber, event.transactionHash, event.occurredAt],
      );
    } else {
      await this.db.query(
        `INSERT INTO insurance_claims(event_id, chain, farm_id, season, claim_id, status, amount, block_number, transaction_hash, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (event_id) DO UPDATE SET status=EXCLUDED.status`,
        [event.id, event.chain, event.farmId, event.season, event.data.claim_id, event.data.status, event.data.amount, event.blockNumber, event.transactionHash, event.occurredAt],
      );
    }
  }
}
