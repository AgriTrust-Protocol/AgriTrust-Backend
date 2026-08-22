import { createHash } from 'crypto';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

export type AuditHash = Buffer;

export interface FarmAuditEventInput {
  farmId: string;
  activityType: string;
  actorId: string;
  location: Record<string, unknown>;
  payload: Record<string, unknown>;
  timestamp?: Date;
}

export interface FarmAuditEventRecord {
  eventId: string;
  farmId: string;
  activityType: string;
  timestamp: Date;
  actorId: string;
  location: Record<string, unknown>;
  payload: Record<string, unknown>;
  prevHash: Buffer;
  hash: Buffer;
  archivedAt?: Date | null;
  coldStorageKey?: string | null;
}

export interface AuditEventQuery {
  farmId?: string;
  activityType?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface AuditProofStep {
  eventId: string;
  timestamp: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AuditProof {
  anchorEventId: string;
  latestEventId: string;
  steps: AuditProofStep[];
}

export interface AuditArchiveStore {
  putObject(key: string, body: Buffer): Promise<void>;
}

const ZERO_HASH = Buffer.alloc(32);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(',')}}`;
}

export function computeAuditHash(
  prevHash: Buffer,
  eventId: string,
  timestamp: Date | string,
  payload: unknown,
): Buffer {
  const timestampIso =
    timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
  return createHash('sha256')
    .update(prevHash)
    .update(eventId)
    .update(timestampIso)
    .update(canonicalJson(payload))
    .digest();
}

export function toHex(hash: Buffer | string): string {
  if (Buffer.isBuffer(hash)) return hash.toString('hex');
  return hash.startsWith('\\x') ? hash.slice(2) : hash;
}

export class FarmActivityAuditService {
  constructor(private readonly pool: Pool) {}

  async appendEvent(input: FarmAuditEventInput): Promise<FarmAuditEventRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.farmId]);

      const previous = await client.query(
        'SELECT hash FROM farm_activity_audit_events WHERE farm_id = $1 ORDER BY timestamp DESC, inserted_at DESC LIMIT 1',
        [input.farmId],
      );
      const prevHash = previous.rows[0]?.hash ? Buffer.from(previous.rows[0].hash) : ZERO_HASH;
      const eventId = uuidv4();
      const timestamp = input.timestamp ?? new Date();
      const hash = computeAuditHash(prevHash, eventId, timestamp, input.payload);

      const inserted = await client.query(
        `INSERT INTO farm_activity_audit_events
          (event_id, farm_id, activity_type, timestamp, actor_id, location, payload, prev_hash, hash)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
         RETURNING event_id, farm_id, activity_type, timestamp, actor_id, location, payload, prev_hash, hash, archived_at, cold_storage_key`,
        [
          eventId,
          input.farmId,
          input.activityType,
          timestamp,
          input.actorId,
          input.location,
          input.payload,
          prevHash,
          hash,
        ],
      );
      await client.query('COMMIT');
      return mapRecord(inserted.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async queryEvents(query: AuditEventQuery): Promise<FarmAuditEventRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    addClause(clauses, values, query.farmId, 'farm_id =');
    addClause(clauses, values, query.activityType, 'activity_type =');
    addClause(clauses, values, query.actorId, 'actor_id =');
    addClause(clauses, values, query.from, 'timestamp >=');
    addClause(clauses, values, query.to, 'timestamp <=');
    values.push(Math.min(query.limit ?? 100, 500));
    values.push(query.offset ?? 0);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT event_id, farm_id, activity_type, timestamp, actor_id, location, payload, prev_hash, hash, archived_at, cold_storage_key
       FROM farm_activity_audit_events ${where}
       ORDER BY timestamp ASC, inserted_at ASC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return result.rows.map(mapRecord);
  }

  async generateProof(eventId: string): Promise<AuditProof> {
    const anchor = await this.pool.query(
      'SELECT farm_id, timestamp, inserted_at FROM farm_activity_audit_events WHERE event_id = $1',
      [eventId],
    );
    if (!anchor.rows[0]) throw new Error('Audit event not found');
    const result = await this.pool.query(
      `SELECT event_id, timestamp, payload, prev_hash, hash
       FROM farm_activity_audit_events
       WHERE farm_id = $1 AND (timestamp, inserted_at) >= ($2, $3)
       ORDER BY timestamp ASC, inserted_at ASC`,
      [anchor.rows[0].farm_id, anchor.rows[0].timestamp, anchor.rows[0].inserted_at],
    );
    const steps = result.rows.map((row) => ({
      eventId: row.event_id,
      timestamp: new Date(row.timestamp).toISOString(),
      payload: row.payload,
      prevHash: toHex(row.prev_hash),
      hash: toHex(row.hash),
    }));
    return { anchorEventId: eventId, latestEventId: steps[steps.length - 1].eventId, steps };
  }

  verifyProof(proof: AuditProof): boolean {
    if (!proof.steps.length || proof.steps[0].eventId !== proof.anchorEventId) return false;
    let expectedPrev: string | null = null;
    for (const step of proof.steps) {
      if (expectedPrev && step.prevHash !== expectedPrev) return false;
      const computed = computeAuditHash(
        Buffer.from(step.prevHash, 'hex'),
        step.eventId,
        step.timestamp,
        step.payload,
      ).toString('hex');
      if (computed !== step.hash) return false;
      expectedPrev = step.hash;
    }
    return proof.latestEventId === proof.steps[proof.steps.length - 1].eventId;
  }

  async archiveExpiredEvents(
    store: AuditArchiveStore,
    options: { retentionYears?: number; now?: Date; batchSize?: number } = {},
  ) {
    const cutoff = new Date(
      (options.now ?? new Date()).getTime() - (options.retentionYears ?? 7) * 365 * MS_PER_DAY,
    );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT event_id, farm_id, activity_type, timestamp, actor_id, location, payload, prev_hash, hash
         FROM farm_activity_audit_events
         WHERE timestamp < $1 AND archived_at IS NULL
         ORDER BY timestamp ASC LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [cutoff, options.batchSize ?? 1000],
      );
      if (!result.rows.length) {
        await client.query('COMMIT');
        return { archivedCount: 0, key: null };
      }
      const key = `farm-audit/year=${cutoff.getUTCFullYear()}/audit-${Date.now()}.json`;
      await store.putObject(key, Buffer.from(JSON.stringify(result.rows), 'utf8'));
      await client.query(
        'UPDATE farm_activity_audit_events SET archived_at = NOW(), cold_storage_key = $1, payload = jsonb_build_object($2::text, hash) WHERE event_id = ANY($3::uuid[])',
        [key, 'archived_anchor_hash', result.rows.map((row) => row.event_id)],
      );
      await client.query('COMMIT');
      return { archivedCount: result.rows.length, key };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

function addClause(clauses: string[], values: unknown[], value: unknown, operator: string): void {
  if (value === undefined) return;
  values.push(value);
  clauses.push(`${operator} $${values.length}`);
}

function mapRecord(row: any): FarmAuditEventRecord {
  return {
    eventId: row.event_id,
    farmId: row.farm_id,
    activityType: row.activity_type,
    timestamp: new Date(row.timestamp),
    actorId: row.actor_id,
    location: row.location,
    payload: row.payload,
    prevHash: Buffer.from(row.prev_hash),
    hash: Buffer.from(row.hash),
    archivedAt: row.archived_at ? new Date(row.archived_at) : null,
    coldStorageKey: row.cold_storage_key ?? null,
  };
}
