declare module 'ioredis' {
  export class Redis {
    constructor(url?: string, options?: Record<string, unknown>);
    connect(): Promise<void>;
    quit(): Promise<void>;
    hset(key: string, field: string, value: string): Promise<number>;
    hget(key: string, field: string): Promise<string | null>;
    hdel(key: string, field: string): Promise<number>;
    hmget(key: string, ...fields: string[]): Promise<(string | null)[]>;
    zadd(key: string, score: number, member: string): Promise<number>;
    zcard(key: string): Promise<number>;
    zpopmin(key: string, count: number): Promise<string[]>;
    zrange(key: string, start: number, stop: number): Promise<string[]>;
    zrem(key: string, member: string): Promise<number>;
    multi(): { hset(key: string, field: string, value: string): unknown; zadd(key: string, score: number, member: string): unknown; zrem(key: string, member: string): unknown; hdel(key: string, field: string): unknown; exec(): Promise<unknown> };
  }
  export default Redis;
}
