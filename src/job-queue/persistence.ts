import Redis, { Redis as RedisClient } from 'ioredis';
import { QueuedJob, Priority, MAX_QUEUED_JOBS } from './types';

/** Redis key prefix for priority sorted sets. */
function priorityKey(p: Priority): string {
  return `jobq:priority:${p}`;
}

/** Redis key for the global job hash (id → serialised job). */
const JOB_HASH_KEY = 'jobq:jobs';

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
    multi.hdel(JOB_HASH_KEY, jobId);
    await multi.exec();
    return true;
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