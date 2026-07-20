/**
 * ConfigStore — Redis-backed configuration storage for feature flags.
 *
 * Responsibilities:
 *   • Load default flags from the YAML file on startup.
 *   • Persist each flag as a Redis Hash field (JSON-encoded).
 *   • Populate the FeatureEngine on startup and after delta patches.
 *   • Background poll every POLL_INTERVAL_MS as a fallback for missed
 *     Pub/Sub messages (staleness tolerance ≤ 30 s local cache TTL).
 *
 * Redis key layout:
 *   feature-flags:store          → Hash, field = flag key, value = JSON
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { FeatureEngine, FlagDefinition } from './engine';

const REDIS_HASH_KEY     = 'feature-flags:store';
const POLL_INTERVAL_MS   = 10_000;   // 10 s background fallback poll
const MAX_FLAGS          = 1_024;
const MAX_PAYLOAD_BYTES  = 64 * 1_024; // 64 KB

export interface RedisHashClient {
  hset(key: string, field: string, value: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, field: string): Promise<number>;
  hvals(key: string): Promise<string[]>;
}

export class ConfigStore {
  private pollTimer?: NodeJS.Timeout;

  constructor(
    private readonly engine:    FeatureEngine,
    private readonly redis:     RedisHashClient,
    private readonly yamlPath?: string,
  ) {}

  // ── Boot sequence ────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    // 1. Load YAML defaults
    const defaults = this.loadYaml();

    // 2. Seed Redis with defaults (only if the hash is still empty)
    const existing = await this.redis.hvals(REDIS_HASH_KEY);
    if (existing.length === 0) {
      for (const flag of defaults) {
        await this.persistToRedis(flag);
      }
    }

    // 3. Populate engine from Redis (Redis is source of truth after boot)
    await this.syncFromRedis();

    // 4. Start background poll
    this.startPolling();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  // ── CRUD helpers (used by admin routes & Propagator) ─────────────────

  async upsertFlag(flag: FlagDefinition): Promise<void> {
    this.validateFlag(flag);
    const current = this.engine.listFlags();
    if (!this.engine.getFlag(flag.key) && current.length >= MAX_FLAGS) {
      throw new Error(`Maximum flag limit of ${MAX_FLAGS} reached`);
    }
    await this.persistToRedis(flag);
    this.engine.setFlag(flag);
  }

  async deleteFlag(key: string): Promise<boolean> {
    await this.redis.hdel(REDIS_HASH_KEY, key);
    const existed = !!this.engine.getFlag(key);
    this.engine.deleteFlag(key);
    return existed;
  }

  async getFlag(key: string): Promise<FlagDefinition | null> {
    const raw = await this.redis.hget(REDIS_HASH_KEY, key);
    if (!raw) return null;
    return JSON.parse(raw) as FlagDefinition;
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private async persistToRedis(flag: FlagDefinition): Promise<void> {
    const encoded = JSON.stringify(flag);
    await this.redis.hset(REDIS_HASH_KEY, flag.key, encoded);
  }

  async syncFromRedis(): Promise<void> {
    const values = await this.redis.hvals(REDIS_HASH_KEY);
    for (const raw of values) {
      try {
        const flag = JSON.parse(raw) as FlagDefinition;
        this.engine.setFlag(flag);
      } catch {
        // skip malformed entries
      }
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      try {
        await this.syncFromRedis();
      } catch {
        // swallow — best-effort fallback
      }
    }, POLL_INTERVAL_MS);

    // Don't hold the process open for polls alone
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  private loadYaml(): FlagDefinition[] {
    const resolvedPath = this.yamlPath ?? join(__dirname, '../../src/config/flags.yaml');
    const altPath      = join(__dirname, '../config/flags.yaml');

    let content: string;
    if (existsSync(resolvedPath)) {
      content = readFileSync(resolvedPath, 'utf8');
    } else if (existsSync(altPath)) {
      content = readFileSync(altPath, 'utf8');
    } else {
      // No YAML file found — start with empty set
      return [];
    }

    const parsed = parse(content) as { flags?: unknown[] };
    if (!Array.isArray(parsed?.flags)) return [];

    return parsed.flags
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
      .map(normaliseFlagEntry)
      .filter((f): f is FlagDefinition => f !== null);
  }

  private validateFlag(flag: FlagDefinition): void {
    if (!flag.key || !/^[a-zA-Z0-9._-]+$/.test(flag.key)) {
      throw new Error(`Invalid flag key: "${flag.key}"`);
    }
    if (flag.rolloutPercentage < 0 || flag.rolloutPercentage > 100) {
      throw new Error(`rolloutPercentage must be 0–100 for flag "${flag.key}"`);
    }
    const payloadSize = Buffer.byteLength(JSON.stringify(flag.payload ?? {}), 'utf8');
    if (payloadSize > MAX_PAYLOAD_BYTES) {
      throw new Error(`Payload for flag "${flag.key}" exceeds 64 KB limit`);
    }
  }
}

// ─── YAML normalisation ───────────────────────────────────────────────────

function normaliseFlagEntry(raw: Record<string, unknown>): FlagDefinition | null {
  if (typeof raw.key !== 'string' || !raw.key.trim()) return null;

  return {
    key:               raw.key.trim(),
    enabled:           raw.enabled !== false,
    rolloutPercentage: typeof raw.rolloutPercentage === 'number'
      ? Math.max(0, Math.min(100, Math.round(raw.rolloutPercentage)))
      : 100,
    targetingRules:    Array.isArray(raw.targetingRules)
      ? (raw.targetingRules as unknown[]).filter(isTargetingRuleRecord).map(normaliseRule)
      : [],
    payload:           typeof raw.payload === 'object' && raw.payload !== null && !Array.isArray(raw.payload)
      ? raw.payload as Record<string, unknown>
      : {},
    variants:          Array.isArray(raw.variants)
      ? (raw.variants as unknown[]).filter((v): v is string => typeof v === 'string')
      : [],
  };
}

function isTargetingRuleRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function normaliseRule(raw: Record<string, unknown>) {
  return {
    attribute: String(raw.attribute ?? ''),
    operator:  String(raw.operator ?? 'eq'),
    value:     raw.value as string | string[] | number,
  } as import('./engine').TargetingRule;
}
