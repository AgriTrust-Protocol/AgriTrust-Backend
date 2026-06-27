import { RATE_LIMIT_MAX_WINDOW_ENTRIES } from '../config/rate-limits';

export interface RedisSortedSetClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<number | string>;
}

export interface AllowResult {
  allowed: boolean;
  remaining: number;
  current: number;
  limit: number;
  retryAfterSeconds: number;
}

const UINT64_MAX = BigInt('18446744073709551615');

export const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local max_entries = tonumber(ARGV[5])
local member = ARGV[6]
local min_score = now - window
redis.call('ZREMRANGEBYSCORE', key, 0, min_score)
local current = redis.call('ZCARD', key)
if current + cost > limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_after = 1
  if oldest[2] ~= nil then
    retry_after = math.max(1, math.ceil((tonumber(oldest[2]) + window - now) / 1000000))
  end
  return {0, current, math.max(0, limit - current), retry_after}
end
for i = 1, cost do
  redis.call('ZADD', key, now, member .. ':' .. i)
end
redis.call('ZREMRANGEBYRANK', key, 0, -(max_entries + 1))
redis.call('PEXPIRE', key, math.ceil(window / 1000))
current = redis.call('ZCARD', key)
return {1, current, math.max(0, limit - current), 0}
`;

export class SlidingWindowCounter {
  constructor(
    private readonly redis: RedisSortedSetClient,
    private readonly windowSeconds: number = 60,
    private readonly maxEntries: number = RATE_LIMIT_MAX_WINDOW_ENTRIES,
  ) {}

  async allow(key: string, limit: number, cost: number = 1): Promise<AllowResult> {
    const boundedCost = this.toUint64(cost, 'cost');
    const boundedLimit = this.toUint64(limit, 'limit');
    const nowMicros = Date.now() * 1000;
    const windowMicros = this.windowSeconds * 1_000_000;
    const member = `${nowMicros}:${process.pid}:${Math.random().toString(36).slice(2)}`;

    const raw = await this.redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      nowMicros,
      windowMicros,
      boundedLimit,
      boundedCost,
      this.maxEntries,
      member,
    );
    const [allowed, current, remaining, retryAfterSeconds] = this.parseLuaResult(raw);

    return {
      allowed: allowed === 1,
      current,
      remaining,
      limit: boundedLimit,
      retryAfterSeconds,
    };
  }

  private toUint64(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) > UINT64_MAX) {
      throw new RangeError(`${field} must be a safe unsigned 64-bit integer`);
    }
    return value;
  }

  private parseLuaResult(raw: number | string): [number, number, number, number] {
    if (Array.isArray(raw)) {
      return raw.map((value) => Number(value)) as [number, number, number, number];
    }
    throw new Error('Redis sliding window script returned an unexpected response');
  }
}
