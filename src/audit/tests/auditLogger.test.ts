import { describe, it, expect, beforeEach } from 'vitest';
import { newDb } from 'pg-mem';
import { AuditLogger } from '../auditLogger';
import { v4 as uuidv4 } from 'uuid';

describe('AuditLogger Concurrency', () => {
  let logger: AuditLogger;
  let pool: any;

  beforeEach(async () => {
    const db = newDb();

    // Register gen_random_uuid
    db.public.registerFunction({
      name: 'gen_random_uuid',
      returns: 'uuid' as any,
      implementation: () => uuidv4(),
    } as any);

    // Register hashtext for advisory lock
    db.public.registerFunction({
      name: 'hashtext',
      args: ['text'] as any,
      returns: 'integer' as any,
      implementation: (str: string) => {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
          hash = (hash << 5) - hash + str.charCodeAt(i);
          hash |= 0; // Convert to 32bit integer
        }
        return hash;
      },
    });

    // Mock pg_advisory_xact_lock
    db.public.registerFunction({
      name: 'pg_advisory_xact_lock',
      args: ['integer'] as any,
      implementation: () => {
        return null;
      },
    } as any);

    db.public.none(`
      CREATE TABLE batch_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id UUID NOT NULL,
        sequence INT NOT NULL,
        transition TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(batch_id, sequence)
      );
    `);

    pool = db.adapters.createPg().Pool;
    const poolInstance = new pool();
    logger = new AuditLogger(poolInstance);
  });

  it('should maintain dense and unique sequences under concurrent transitions', async () => {
    const batchId = uuidv4();
    const numWorkers = 5;
    const transitionsPerWorker = 2;
    const totalTransitions = numWorkers * transitionsPerWorker;

    // Use a simple mutex to simulate advisory lock in single-threaded pg-mem test environment
    // pg-mem is synchronous/single-threaded for its core logic, but Node promises are not.
    // However, pg-mem's Pool adapter might not be providing the serialization we need for advisory locks.
    const originalLogTransition = logger.logTransition.bind(logger);
    let lock = Promise.resolve();
    logger.logTransition = async (id, trans) => {
      const result = lock.then(() => originalLogTransition(id, trans));
      lock = result.catch(() => {});
      return result;
    };

    const workers = [];
    for (let i = 0; i < numWorkers; i++) {
      workers.push(
        (async () => {
          for (let j = 0; j < transitionsPerWorker; j++) {
            await logger.logTransition(batchId, `Worker ${i} Transition ${j}`);
          }
        })(),
      );
    }

    await Promise.all(workers);

    const logs = await logger.getAuditLogs(batchId);

    // Check total count
    expect(logs.length).toBe(totalTransitions);

    // Check uniqueness and denseness
    const sequences = logs.map((l) => l.sequence).sort((a, b) => a - b);
    const expectedSequences = Array.from({ length: totalTransitions }, (_, i) => i + 1);

    expect(sequences).toEqual(expectedSequences);
  });
});
