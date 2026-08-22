import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('agritrust.inventory.silo_lock');

interface LockHandle {
  client: PoolClient;
  siloId: number;
  binId: number;
  requestId: string;
  acquiredAt: number;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});

const activeLocks = new Map<string, LockHandle>();

function lockKey(siloId: number, binId: number): string {
  return `${siloId}:${binId}`;
}

function hashSiloBin(siloId: number, binId: number): bigint {
  const combined = (BigInt(siloId) << BigInt(32)) | BigInt(binId);
  return combined ^ BigInt('0x9E3779B97F4A7C15');
}

export async function acquireSiloBinLock(
  siloId: number,
  binId: number,
  timeoutMs = 5000,
): Promise<boolean> {
  const requestId = uuidv4();
  const key = lockKey(siloId, binId);
  const lockValue = hashSiloBin(siloId, binId);

  return tracer.startActiveSpan('acquireSiloBinLock', async (span) => {
    span.setAttribute('silo_id', siloId);
    span.setAttribute('bin_id', binId);
    span.setAttribute('request_id', requestId);
    span.setAttribute('lock_value', lockValue.toString());
    span.setAttribute('timeout_ms', timeoutMs);

    const client = await pool.connect();
    const startTime = Date.now();

    try {
      await client.query(`SET statement_timeout = ${timeoutMs}`);

      try {
        await client.query('SELECT pg_advisory_lock($1)', [lockValue]);
      } catch (_err) {
        const elapsed = Date.now() - startTime;
        span.setAttribute('acquisition_time_ms', elapsed);
        span.addEvent('lock_timeout', {
          silo_id: siloId,
          bin_id: binId,
          request_id: requestId,
          elapsed_ms: elapsed,
          timeout_ms: timeoutMs,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        client.release();
        return false;
      }

      await client.query('SET statement_timeout = 0');

      const elapsed = Date.now() - startTime;
      span.setAttribute('acquisition_time_ms', elapsed);

      if (elapsed > 1000) {
        span.addEvent('lock_contention', {
          silo_id: siloId,
          bin_id: binId,
          request_id: requestId,
          elapsed_ms: elapsed,
        });
      }

      const handle: LockHandle = {
        client,
        siloId,
        binId,
        requestId,
        acquiredAt: Date.now(),
      };

      activeLocks.set(key, handle);
      span.setStatus({ code: SpanStatusCode.OK });
      return true;
    } catch (err) {
      client.release();
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

export async function releaseSiloBinLock(siloId: number, binId: number): Promise<boolean> {
  const key = lockKey(siloId, binId);
  const handle = activeLocks.get(key);
  if (!handle) {
    return false;
  }

  const lockValue = hashSiloBin(siloId, binId);

  return tracer.startActiveSpan('releaseSiloBinLock', async (span) => {
    span.setAttribute('silo_id', siloId);
    span.setAttribute('bin_id', binId);
    span.setAttribute('request_id', handle.requestId);
    span.setAttribute('held_ms', Date.now() - handle.acquiredAt);

    try {
      await handle.client.query('SET statement_timeout = 0');
      await handle.client.query('SELECT pg_advisory_unlock($1)', [lockValue]);
      activeLocks.delete(key);
      span.setStatus({ code: SpanStatusCode.OK });
      return true;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      handle.client.release();
      span.end();
    }
  });
}

export function getActiveLockCount(): number {
  return activeLocks.size;
}
