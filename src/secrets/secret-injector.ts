import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { parse } from 'dotenv';
import { secretsConfig, SecretMapping } from '../config/secrets';
import { LeaseManager } from './lease-manager';
import { VaultClient } from './vault-client';

interface StaticCacheEntry {
  expiresAt: number;
  value: Record<string, unknown>;
}

export class SecretInjector {
  private readonly staticCache = new Map<string, StaticCacheEntry>();

  constructor(
    private readonly vaultClient: VaultClient,
    private readonly leaseManager: LeaseManager,
    private readonly config = secretsConfig,
  ) {}

  async injectAtBoot(): Promise<void> {
    try {
      await this.injectMappings(this.config.mappings, false);
    } catch (error) {
      console.warn('[Vault] Startup injection failed; attempting .env.vault fallback:', error instanceof Error ? error.message : error);
      if (!this.injectLastKnownGoodEnv()) throw error;
    }
  }

  async getSecret(path: string): Promise<Record<string, unknown>> {
    const cached = this.staticCache.get(path);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const response = await this.vaultClient.read(path, true);
    return response.data;
  }

  async injectMappings(mappings: SecretMapping[], audit: boolean): Promise<void> {
    if (mappings.length > this.config.maxSecretsPerPod) {
      throw new Error(`Refusing to inject more than ${this.config.maxSecretsPerPod} secret paths`);
    }

    for (const mapping of mappings) {
      const response = await this.vaultClient.read(mapping.path, audit);
      const value = mapping.field ? response.data[mapping.field] : response.data[mapping.envKey];
      if (value != null) process.env[mapping.envKey] = String(value);

      if (mapping.engine === 'kv-v2') {
        this.staticCache.set(mapping.path, {
          value: response.data,
          expiresAt: Date.now() + (mapping.cacheTtlMs ?? this.config.staticCacheTtlMs),
        });
      } else {
        this.leaseManager.track(response.leaseId, response.leaseDuration, response.renewable ?? true);
      }
    }
  }

  injectLastKnownGoodEnv(): boolean {
    if (!existsSync(this.config.encryptedBackupPath)) return false;
    const decrypted = this.decryptBackup();
    const parsed = parse(decrypted);
    for (const [key, value] of Object.entries(parsed)) process.env[key] = value;
    console.warn('[Vault] Using last-known-good .env.vault fallback; rotate credentials as soon as Vault is reachable.');
    return true;
  }

  private decryptBackup(): Buffer {
    if (this.config.ageIdentityPath) {
      return execFileSync('age', ['--decrypt', '--identity', this.config.ageIdentityPath, this.config.encryptedBackupPath]);
    }
    return readFileSync(this.config.encryptedBackupPath);
  }
}
