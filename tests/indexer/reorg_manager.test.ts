import { describe, expect, it } from 'vitest';
import { EventMaterializer, ReorgManager, RawChainEvent } from '../../src/indexer';

class MemoryDb {
  raw: RawChainEvent[] = [];
  yields: any[] = [];
  cursor: any;
  async query(sql: string, params: any[] = []): Promise<any> {
    if (sql.startsWith('INSERT INTO raw_events')) {
      this.raw = this.raw.filter((e) => !(e.chain === params[0] && e.transactionHash === params[3] && e.logIndex === params[4]));
      this.raw.push({ chain: params[0], blockNumber: params[1], blockHash: params[2], transactionHash: params[3], logIndex: params[4], contractAddress: params[5], eventName: params[6], payload: params[7] });
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO farm_yields')) {
      this.yields = this.yields.filter((r) => r.event_id !== params[0]);
      this.yields.push({ event_id: params[0], chain: params[1], farm_id: params[2], season: params[3], block_number: params[7], transaction_hash: params[8] });
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO indexer_cursors')) {
      this.cursor = { chain: params[0], last_block: Math.max(Number(this.cursor?.last_block ?? 0), Number(params[1])), block_hash: params[2] };
      return { rows: [] };
    }
    if (sql.startsWith('SELECT last_block')) return { rows: this.cursor ? [this.cursor] : [] };
    if (sql.startsWith('DELETE FROM raw_events')) {
      this.raw = this.raw.filter((e) => !(e.chain === params[0] && e.blockNumber >= params[1]));
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM farm_yields')) {
      this.yields = this.yields.filter((e) => !(e.chain === params[0] && e.block_number >= params[1]));
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM')) return { rows: [] };
    if (sql.startsWith('UPDATE indexer_cursors')) {
      this.cursor = { chain: params[0], last_block: params[1], block_hash: null };
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

function yieldEvent(blockNumber: number, blockHash = `hash-${blockNumber}`): RawChainEvent {
  return {
    chain: 'polygon',
    blockNumber,
    blockHash,
    transactionHash: `0xtx${blockNumber}`,
    logIndex: 0,
    contractAddress: '0xyield',
    eventName: 'YieldPublished',
    payload: { farm_id: 'farm-1', season: '2026A', crop: 'maize', quantity: blockNumber, unit: 'kg' },
  };
}

describe('polygon reorg handling', () => {
  it('rolls back a 10-block reorg and indexes corrected events', async () => {
    const db = new MemoryDb();
    const materializer = new EventMaterializer(db as any);
    for (let block = 100; block <= 109; block += 1) await materializer.ingest(yieldEvent(block));

    const reorg = new ReorgManager(db as any, { polygon: 64 });
    await expect(reorg.handleBlock('polygon', 100, 'new-hash-100')).resolves.toBe(true);
    expect(db.yields).toHaveLength(0);

    for (let block = 100; block <= 109; block += 1) await materializer.ingest(yieldEvent(block, `new-hash-${block}`));
    expect(db.yields).toHaveLength(10);
    expect(db.yields.map((row) => row.block_number)).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    expect(db.cursor.last_block).toBe(109);
  });
});
