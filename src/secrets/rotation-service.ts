import { SecretMapping } from '../config/secrets';
import { LeaseManager } from './lease-manager';
import { RotatingPgPoolFactory } from './dynamic-pg-pool';
import { VaultClient } from './vault-client';
import {
  secretRotationAttemptsTotal,
  secretRotationDurationSeconds,
  secretRotationLastSuccessTimestamp,
  secretRotationStalenessSeconds,
} from './rotation-metrics';

export type RotationTargetType = 'database' | 'api-key';

export interface RotationTarget {
  name: string;
  type: RotationTargetType;
  path: string;
  usernameField?: string;
  passwordField?: string;
  envKey?: string;
  field?: string;
  intervalMs: number;
  canary?: (candidate: Record<string, unknown>) => Promise<void>;
}

export interface RotationResult {
  target: string;
  type: RotationTargetType;
  rotatedAt: string;
  durationMs: number;
  leaseId?: string;
}

export class SecretRotationService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastSuccess = new Map<string, number>();

  constructor(
    private readonly vaultClient: VaultClient,
    private readonly leaseManager: LeaseManager,
    private readonly pgPoolFactory?: RotatingPgPoolFactory,
    private readonly now = () => Date.now(),
  ) {}

  static targetsFromMappings(mappings: SecretMapping[], intervalMs: number): RotationTarget[] {
    return mappings.map((mapping) => ({
      name: mapping.envKey,
      type: mapping.engine === 'database' ? 'database' : 'api-key',
      path: mapping.path,
      envKey: mapping.envKey,
      field: mapping.field,
      usernameField: mapping.engine === 'database' ? 'username' : undefined,
      passwordField: mapping.engine === 'database' ? 'password' : undefined,
      intervalMs,
    }));
  }

  start(targets: RotationTarget[]): void {
    for (const target of targets) this.schedule(target, 0);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async rotate(target: RotationTarget): Promise<RotationResult> {
    const start = this.now();
    try {
      const response = await this.vaultClient.read(target.path, true);
      await target.canary?.(response.data);

      if (target.type === 'database') {
        const username = String(response.data[target.usernameField ?? 'username'] ?? '');
        const password = String(response.data[target.passwordField ?? 'password'] ?? '');
        if (!username || !password) throw new Error(`Vault response for ${target.name} is missing database credentials`);
        this.pgPoolFactory?.create(username, password);
        this.leaseManager.track(response.leaseId, response.leaseDuration, response.renewable ?? true);
      } else if (target.envKey) {
        const value = response.data[target.field ?? target.envKey];
        if (value == null) throw new Error(`Vault response for ${target.name} is missing ${target.field ?? target.envKey}`);
        process.env[target.envKey] = String(value);
      }

      const durationMs = this.now() - start;
      this.recordSuccess(target, durationMs);
      return { target: target.name, type: target.type, rotatedAt: new Date(this.now()).toISOString(), durationMs, leaseId: response.leaseId };
    } catch (error) {
      secretRotationAttemptsTotal.inc({ target: target.name, type: target.type, result: 'failure' });
      throw error;
    }
  }

  getStalenessSeconds(target: RotationTarget): number | undefined {
    const last = this.lastSuccess.get(target.name);
    return last == null ? undefined : Math.max(0, Math.floor((this.now() - last) / 1000));
  }

  private schedule(target: RotationTarget, delayMs: number): void {
    const timer = setTimeout(async () => {
      try {
        await this.rotate(target);
      } catch (error) {
        console.error(`[Vault] Secret rotation failed for ${target.name}:`, error instanceof Error ? error.message : error);
      } finally {
        this.schedule(target, target.intervalMs);
      }
    }, delayMs);
    timer.unref?.();
    this.timers.set(target.name, timer);
  }

  private recordSuccess(target: RotationTarget, durationMs: number): void {
    const timestamp = this.now();
    this.lastSuccess.set(target.name, timestamp);
    secretRotationAttemptsTotal.inc({ target: target.name, type: target.type, result: 'success' });
    secretRotationDurationSeconds.observe({ target: target.name, type: target.type }, durationMs / 1000);
    secretRotationLastSuccessTimestamp.set({ target: target.name, type: target.type }, timestamp / 1000);
    secretRotationStalenessSeconds.set({ target: target.name, type: target.type }, 0);
  }
}
