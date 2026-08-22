/**
 * Feature Flag Evaluation Engine
 *
 * Evaluates flag state entirely from an in-memory Map — no RPC in the hot
 * path.  Target: < 1 µs per isEnabled() call.
 *
 * Evaluation order (first decisive step wins):
 *   1. Kill-switch  — flag.enabled === false  → disabled
 *   2. Enabled gate — flag.enabled === true   → continue
 *   3. Targeting    — first matching rule      → enabled
 *   4. Rollout %    — deterministic hash       → enabled / disabled
 */

import { createHash } from 'crypto';
import { Histogram, Counter } from 'prom-client';
import { metricsRegistry } from '../api/metrics/registry';

// ─── Types ────────────────────────────────────────────────────────────────

export type TargetingAttribute = 'tenantId' | 'region' | 'agentRole' | 'bucket';
export type TargetingOperator = 'eq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte';

export interface TargetingRule {
  attribute: TargetingAttribute;
  operator: TargetingOperator;
  value: string | string[] | number;
}

export interface FlagDefinition {
  key: string;
  enabled: boolean;
  rolloutPercentage: number; // 0 – 100 integer
  targetingRules: TargetingRule[];
  payload: Record<string, unknown>;
  variants: string[];
}

export interface EvaluationContext {
  tenantId: string;
  region?: string;
  agentRole?: string;
  /** Pre-computed 0-99 sample bucket; defaults to hash(tenantId) % 100 */
  bucket?: number;
}

export interface EvaluationResult {
  enabled: boolean;
  reason: 'kill-switch' | 'targeting' | 'rollout' | 'default-off';
  variant?: string;
  payload: Record<string, unknown>;
}

// ─── Metrics ─────────────────────────────────────────────────────────────

const evaluationDuration = new Histogram({
  name: 'feature_flag_evaluation_duration_ns',
  help: 'Feature flag evaluation duration in nanoseconds (nanosecond resolution via process.hrtime)',
  labelNames: ['flag', 'result'] as const,
  buckets: [100, 500, 1_000, 5_000, 10_000, 50_000],
  registers: [metricsRegistry],
});

const evaluationTotal = new Counter({
  name: 'feature_flag_evaluations_total',
  help: 'Total feature flag evaluations',
  labelNames: ['flag', 'result'] as const,
  registers: [metricsRegistry],
});

// ─── Engine ───────────────────────────────────────────────────────────────

export class FeatureEngine {
  /**
   * Internal store — populated by ConfigStore / Propagator.
   * Direct Map access keeps evaluation in the nanosecond range.
   */
  private readonly flags = new Map<string, FlagDefinition>();

  // ── Mutation API (used by ConfigStore & Propagator) ─────────────────

  setFlag(def: FlagDefinition): void {
    this.flags.set(def.key, def);
  }

  deleteFlag(key: string): void {
    this.flags.delete(key);
  }

  listFlags(): FlagDefinition[] {
    return [...this.flags.values()];
  }

  getFlag(key: string): FlagDefinition | undefined {
    return this.flags.get(key);
  }

  // ── Hot-path evaluation ──────────────────────────────────────────────

  /**
   * isEnabled — < 1 µs in steady state (pure in-memory).
   */
  isEnabled(key: string, ctx: EvaluationContext): boolean {
    return this.evaluate(key, ctx).enabled;
  }

  evaluate(key: string, ctx: EvaluationContext): EvaluationResult {
    const start = process.hrtime.bigint();

    const result = this._evaluate(key, ctx);

    const elapsedNs = Number(process.hrtime.bigint() - start);
    evaluationDuration.observe(
      { flag: key, result: result.enabled ? 'enabled' : 'disabled' },
      elapsedNs,
    );
    evaluationTotal.inc({ flag: key, result: result.enabled ? 'enabled' : 'disabled' });

    return result;
  }

  private _evaluate(key: string, ctx: EvaluationContext): EvaluationResult {
    const flag = this.flags.get(key);

    if (!flag) {
      return { enabled: false, reason: 'default-off', payload: {} };
    }

    // Step 1 — Kill-switch
    if (!flag.enabled) {
      return { enabled: false, reason: 'kill-switch', payload: flag.payload };
    }

    // Step 2 — Targeting rules (ordered; first match wins)
    for (const rule of flag.targetingRules) {
      if (matchesRule(ctx, rule)) {
        const variant = flag.variants[0];
        return {
          enabled: true,
          reason: 'targeting',
          variant,
          payload: flag.payload,
        };
      }
    }

    // Step 3 — Gradual rollout (deterministic hash modulo 100)
    const bucket = ctx.bucket ?? tenantBucket(ctx.tenantId);
    if (bucket < flag.rolloutPercentage) {
      const variantIndex = bucket % Math.max(flag.variants.length, 1);
      const variant = flag.variants[variantIndex];
      return {
        enabled: true,
        reason: 'rollout',
        variant,
        payload: flag.payload,
      };
    }

    return { enabled: false, reason: 'default-off', payload: flag.payload };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Deterministic bucket: SHA-256(tenantId) → first 4 bytes as uint32 → % 100.
 * Result is stable for the same tenantId across all nodes.
 */
export function tenantBucket(tenantId: string): number {
  const hash = createHash('sha256').update(tenantId).digest();
  const uint = hash.readUInt32BE(0);
  return uint % 100;
}

function matchesRule(ctx: EvaluationContext, rule: TargetingRule): boolean {
  const raw: string | number | undefined = (() => {
    switch (rule.attribute) {
      case 'tenantId':
        return ctx.tenantId;
      case 'region':
        return ctx.region;
      case 'agentRole':
        return ctx.agentRole;
      case 'bucket':
        return ctx.bucket ?? tenantBucket(ctx.tenantId);
      default:
        return undefined;
    }
  })();

  if (raw === undefined) return false;

  switch (rule.operator) {
    case 'eq':
      return String(raw) === String(rule.value);
    case 'in': {
      const arr = Array.isArray(rule.value) ? rule.value : [String(rule.value)];
      return arr.includes(String(raw));
    }
    case 'lt':
      return Number(raw) < Number(rule.value);
    case 'lte':
      return Number(raw) <= Number(rule.value);
    case 'gt':
      return Number(raw) > Number(rule.value);
    case 'gte':
      return Number(raw) >= Number(rule.value);
    default:
      return false;
  }
}
