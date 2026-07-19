import { ChainName } from './types';
import { Queryable } from './materializer';

const TABLES = ['farm_yields', 'settlements', 'provenance_events', 'insurance_claims'];

export class ReorgManager {
  constructor(private readonly db: Queryable, private readonly windows: Partial<Record<ChainName, number>> = { polygon: 64 }) {}

  async handleBlock(chain: ChainName, blockNumber: number, blockHash: string): Promise<boolean> {
    const result = await this.db.query('SELECT last_block, block_hash FROM indexer_cursors WHERE chain=$1', [chain]);
    const cursor = result.rows?.[0];
    if (!cursor) return false;
    const lastBlock = Number(cursor.last_block);
    const reorg = blockNumber <= lastBlock && cursor.block_hash !== blockHash;
    if (!reorg) return false;
    const fromBlock = Math.max(0, blockNumber - (this.windows[chain] ?? 0));
    await this.rollback(chain, fromBlock);
    return true;
  }

  async rollback(chain: ChainName, fromBlock: number): Promise<void> {
    for (const table of TABLES) await this.db.query(`DELETE FROM ${table} WHERE chain=$1 AND block_number >= $2`, [chain, fromBlock]);
    await this.db.query('DELETE FROM raw_events WHERE chain=$1 AND block_number >= $2', [chain, fromBlock]);
    await this.db.query('UPDATE indexer_cursors SET last_block=$2, block_hash=NULL, updated_at=NOW() WHERE chain=$1', [chain, Math.max(0, fromBlock - 1)]);
  }
}
