import Redis, { Redis as RedisClient } from 'ioredis';
import { DeadLetterJob, QueuedJob, Priority, MAX_QUEUED_JOBS } from './types';
import {
  jobLeaseClaimDurationSeconds,
  jobLeaseClaimsTotal,
  jobLeasesActive,
  jobLeaseReclaimsTotal,
} from './metrics';

/** Redis key for the lease sorted set (score = expiry unix ms). */
const LEASE_ZSET_KEY = 'jobq:leases';

/** Redis key prefix for priority sorted sets. */
function priorityKey(p: Priority): string {
  return `jobq:priority:${p}`;
}

/** Redis key for the global job hash (id → serialised job). */
const JOB_HASH_KEY = 'jobq:jobs';
const DLQ_HASH_KEY = 'jobq:dlq:jobs';
const DLQ_INDEX_KEY = 'jobq:dlq:index';

/**
 * Redis-backed persistence layer for the job queue.
 *
 * Each priority level gets its own sorted set where the score is the
 * submission timestamp (unix ms).  The global job hash stores the
 * full serialised job so we can reconstruct it on dequeue.
 */
export class JobQueuePersistence {
  private redis: RedisClient;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: true });
  }

  /** Connect to Redis. */
  async connect(): Promise<void> {
    await this.redis.connect();
  }

  /** Disconnect (graceful shutdown). */
  async disconnect(): Promise<void> {
    await this.redis.quit();
  }

  /** Enqueue a job.  Rejects with 503 if the global cap is exceeded. */
  async enqueue(job: QueuedJob): Promise<void> {
    const total = await this.redis.zcard(priorityKey(job.priority));
    // Fast approximate check — exact count across all priorities is O(N).
    if (total >= MAX_QUEUED_JOBS / 5) {
      const all = await Promise.all(
        [1, 2, 3, 4, 5].map((p) => this.redis.zcard(priorityKey(p as Priority))),
      );
      const sum = all.reduce((a: number, b: number) => a + b, 0);
      if (sum >= MAX_QUEUED_JOBS) {
        throw new QueueFullError();
      }
    }

    const serialised = JSON.stringify(job);
    const multi = this.redis.multi();
    multi.hset(JOB_HASH_KEY, job.id, serialised);
    multi.zadd(priorityKey(job.priority), job.submittedAt, job.id);
    await multi.exec();
  }

  /**
   * Atomically claim the oldest pending job for a priority level under a lease.
   * The Lua script removes the job from its priority set, stamps lease metadata
   * in the job hash, and records the lease expiry in a global sorted set.
   */
  async claimDue(
    priority: Priority,
    workerId: string,
    leaseMs: number,
    now = Date.now(),
  ): Promise<QueuedJob | null> {
    const end = jobLeaseClaimDurationSeconds.startTimer();
    try {
      const leaseExpiresAt = now + leaseMs;
      const result = await (
        this.redis as unknown as { call: (...args: unknown[]) => Promise<unknown> }
      ).call(
        'EVAL',
        `
        local job_id = redis.call('ZRANGE', KEYS[1], 0, 0)[1]
        if not job_id then return nil end
        local raw = redis.call('HGET', KEYS[2], job_id)
        if not raw then
          redis.call('ZREM', KEYS[1], job_id)
          return nil
        end
        redis.call('ZREM', KEYS[1], job_id)
        redis.call('ZADD', KEYS[3], ARGV[2], job_id)
        return raw
        `,
        3,
        priorityKey(priority),
        JOB_HASH_KEY,
        LEASE_ZSET_KEY,
        workerId,
        String(leaseExpiresAt),
      );

      if (typeof result !== 'string') {
        jobLeaseClaimsTotal.inc({ result: 'empty' });
        return null;
      }

      const job = JSON.parse(result) as QueuedJob;
      const claimed: QueuedJob = {
        ...job,
        leaseOwner: workerId,
        leaseExpiresAt,
        lastClaimedAt: now,
      };
      await this.redis.hset(JOB_HASH_KEY, job.id, JSON.stringify(claimed));
      jobLeaseClaimsTotal.inc({ result: 'claimed' });
      return claimed;
    } catch (err) {
      jobLeaseClaimsTotal.inc({ result: 'error' });
      throw err;
    } finally {
      end();
      await this.refreshActiveLeaseMetric();
    }
  }

  /** Acknowledge a completed job and remove its lease. */
  async ack(jobId: string, workerId: string): Promise<boolean> {
    const raw = await this.redis.hget(JOB_HASH_KEY, jobId);
    if (!raw) return false;
    const job = JSON.parse(raw) as QueuedJob;
    if (job.leaseOwner !== workerId) return false;
    const multi = this.redis.multi();
    multi.hdel(JOB_HASH_KEY, jobId);
    multi.zrem(LEASE_ZSET_KEY, jobId);
    await multi.exec();
    await this.refreshActiveLeaseMetric();
    return true;
  }

  /** Release a claimed job back to its priority queue when dispatch cannot start. */
  async releaseLease(job: QueuedJob, workerId: string, submittedAt = Date.now()): Promise<boolean> {
    if (job.leaseOwner !== workerId) return false;
    const released: QueuedJob = { ...job, submittedAt };
    delete released.leaseOwner;
    delete released.leaseExpiresAt;
    const multi = this.redis.multi();
    multi.hset(JOB_HASH_KEY, job.id, JSON.stringify(released));
    multi.zrem(LEASE_ZSET_KEY, job.id);
    multi.zadd(priorityKey(job.priority), submittedAt, job.id);
    await multi.exec();
    await this.refreshActiveLeaseMetric();
    return true;
  }

  /** Requeue expired leases so another scheduler instance can claim them. */
  async reclaimExpiredLeases(now = Date.now(), limit = 100): Promise<number> {
    const ids = (await (
      this.redis as unknown as { call: (...args: unknown[]) => Promise<unknown> }
    ).call(
      'ZRANGEBYSCORE',
      LEASE_ZSET_KEY,
      '0',
      String(now),
      'LIMIT',
      '0',
      String(limit),
    )) as string[];
    let reclaimed = 0;
    for (const id of ids) {
      const raw = await this.redis.hget(JOB_HASH_KEY, id);
      if (!raw) {
        await this.redis.zrem(LEASE_ZSET_KEY, id);
        continue;
      }
      const job = JSON.parse(raw) as QueuedJob;
      if (!job.leaseExpiresAt || job.leaseExpiresAt > now) continue;
      const retryJob: QueuedJob = {
        ...job,
        retryCount: (job.retryCount ?? 0) + 1,
        submittedAt: now,
      };
      delete retryJob.leaseOwner;
      delete retryJob.leaseExpiresAt;
      const multi = this.redis.multi();
      multi.hset(JOB_HASH_KEY, id, JSON.stringify(retryJob));
      multi.zrem(LEASE_ZSET_KEY, id);
      multi.zadd(priorityKey(retryJob.priority), now, id);
      await multi.exec();
      reclaimed += 1;
    }
    if (reclaimed > 0) jobLeaseReclaimsTotal.inc(reclaimed);
    await this.refreshActiveLeaseMetric();
    return reclaimed;
  }

  private async refreshActiveLeaseMetric(): Promise<void> {
    jobLeasesActive.set(await this.redis.zcard(LEASE_ZSET_KEY));
  }

  /**
   * Dequeue the oldest job from a priority level.  Returns null if the
   * level is empty.
   */
  async dequeue(priority: Priority): Promise<QueuedJob | null> {
    const ids = await this.redis.zpopmin(priorityKey(priority), 1);
    if (ids.length === 0) return null;

    const id = ids[0];
    const raw = await this.redis.hget(JOB_HASH_KEY, id);
    if (!raw) return null;

    await this.redis.hdel(JOB_HASH_KEY, id);
    return JSON.parse(raw) as QueuedJob;
  }

  /** Peek at the oldest job in a priority level without dequeuing. */
  async peek(priority: Priority): Promise<QueuedJob | null> {
    const ids = await this.redis.zrange(priorityKey(priority), 0, 0);
    if (ids.length === 0) return null;

    const raw = await this.redis.hget(JOB_HASH_KEY, ids[0]);
    return raw ? (JSON.parse(raw) as QueuedJob) : null;
  }

  /** Delete a job by id (admin cancel). */
  async remove(jobId: string): Promise<boolean> {
    const raw = await this.redis.hget(JOB_HASH_KEY, jobId);
    if (!raw) return false;

    const job = JSON.parse(raw) as QueuedJob;
    const multi = this.redis.multi();
    multi.zrem(priorityKey(job.priority), jobId);
    multi.zrem(LEASE_ZSET_KEY, jobId);
    multi.hdel(JOB_HASH_KEY, jobId);
    await multi.exec();
    return true;
  }

  /** Persist a terminally failed job in the dead letter queue. */
  async deadLetter(job: DeadLetterJob): Promise<void> {
    const serialised = JSON.stringify(job);
    const multi = this.redis.multi();
    multi.hset(DLQ_HASH_KEY, job.id, serialised);
    multi.zadd(DLQ_INDEX_KEY, job.failedAt, job.id);
    await multi.exec();
  }

  /** List recent dead-lettered jobs, newest first. */
  async listDeadLetters(limit = 100): Promise<DeadLetterJob[]> {
    const ids = (await (
      this.redis as unknown as { call: (...args: string[]) => Promise<unknown> }
    ).call('ZREVRANGE', DLQ_INDEX_KEY, '0', String(Math.max(0, limit - 1)))) as string[];
    if (ids.length === 0) return [];

    const raws = await this.redis.hmget(DLQ_HASH_KEY, ...ids);
    return raws
      .filter((r): r is string => r !== null)
      .map((r: string) => JSON.parse(r) as DeadLetterJob);
  }

  /** Get one dead-lettered job by id. */
  async getDeadLetter(jobId: string): Promise<DeadLetterJob | null> {
    const raw = await this.redis.hget(DLQ_HASH_KEY, jobId);
    return raw ? (JSON.parse(raw) as DeadLetterJob) : null;
  }

  /** Replay a dead-lettered job by moving it back to the live queue. */
  async replayDeadLetter(jobId: string): Promise<DeadLetterJob | null> {
    const dead = await this.getDeadLetter(jobId);
    if (!dead) return null;

    const retryJob: QueuedJob = {
      id: dead.id,
      type: dead.type,
      priority: dead.priority,
      payload: dead.payload,
      submittedAt: Date.now(),
      retryCount: 0,
    };
    const multi = this.redis.multi();
    multi.hdel(DLQ_HASH_KEY, jobId);
    multi.zrem(DLQ_INDEX_KEY, jobId);
    multi.hset(JOB_HASH_KEY, retryJob.id, JSON.stringify(retryJob));
    multi.zadd(priorityKey(retryJob.priority), retryJob.submittedAt, retryJob.id);
    await multi.exec();
    return dead;
  }

  /** Permanently delete a dead-lettered job after operator review. */
  async purgeDeadLetter(jobId: string): Promise<boolean> {
    const removed = await this.redis.hdel(DLQ_HASH_KEY, jobId);
    if (removed === 0) return false;
    await this.redis.zrem(DLQ_INDEX_KEY, jobId);
    return true;
  }

  /** Get total dead-letter queue depth. */
  async deadLetterDepth(): Promise<number> {
    return this.redis.zcard(DLQ_INDEX_KEY);
  }

  /** Get total queue depth across all priorities. */
  async totalDepth(): Promise<number> {
    const counts = await Promise.all(
      [1, 2, 3, 4, 5].map((p) => this.redis.zcard(priorityKey(p as Priority))),
    );
    return counts.reduce((a: number, b: number) => a + b, 0);
  }

  /** Get queue depth per priority level. */
  async depthByPriority(): Promise<Record<number, number>> {
    const result: Record<number, number> = {};
    for (const p of [1, 2, 3, 4, 5]) {
      result[p] = await this.redis.zcard(priorityKey(p as Priority));
    }
    return result;
  }

  /** Get all pending jobs for a priority level (for snapshot). */
  async peekAll(priority: Priority, limit = 100): Promise<QueuedJob[]> {
    const ids = await this.redis.zrange(priorityKey(priority), 0, limit - 1);
    if (ids.length === 0) return [];

    const raws = await this.redis.hmget(JOB_HASH_KEY, ...ids);
    return raws
      .filter((r): r is string => r !== null)
      .map((r: string) => JSON.parse(r) as QueuedJob);
  }
}

export class QueueFullError extends Error {
  constructor() {
    super('Queue capacity reached — try again later');
    this.name = 'QueueFullError';
  }
}
