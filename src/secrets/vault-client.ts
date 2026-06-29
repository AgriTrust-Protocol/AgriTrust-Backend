import { secretsConfig } from '../config/secrets';
import { AuditLogger } from './audit-logger';

export interface VaultSecretResponse<T = Record<string, unknown>> {
  data: T;
  leaseId?: string;
  leaseDuration?: number;
  renewable?: boolean;
}

interface VaultApiResponse {
  data?: any;
  lease_id?: string;
  lease_duration?: number;
  renewable?: boolean;
  auth?: { client_token?: string; lease_duration?: number; renewable?: boolean };
}

export class VaultClient {
  private token?: string;
  private tokenRenewTimer?: NodeJS.Timeout;

  constructor(
    private readonly config = secretsConfig,
    private readonly auditLogger = new AuditLogger(),
  ) {
    this.token = config.token;
    this.scheduleTokenRenewal(60 * 60);
  }

  async read<T = Record<string, unknown>>(path: string, audit = true): Promise<VaultSecretResponse<T>> {
    if (audit) await this.auditLogger.logAccess(path);
    const payload = await this.request<VaultApiResponse>('GET', `/v1/${path}`);
    const data = payload.data?.data ?? payload.data ?? {};
    return {
      data: data as T,
      leaseId: payload.lease_id,
      leaseDuration: payload.lease_duration,
      renewable: payload.renewable,
    };
  }

  async renewLease(leaseId: string, incrementSeconds: number): Promise<{ ttlSeconds: number; renewable: boolean }> {
    const payload = await this.request<VaultApiResponse>('PUT', '/v1/sys/leases/renew', {
      lease_id: leaseId,
      increment: incrementSeconds,
    });
    return {
      ttlSeconds: payload.lease_duration ?? incrementSeconds,
      renewable: payload.renewable ?? true,
    };
  }

  async renewTokenSelf(incrementSeconds = 3600): Promise<void> {
    const payload = await this.request<VaultApiResponse>('POST', '/v1/auth/token/renew-self', { increment: incrementSeconds });
    const ttl = payload.auth?.lease_duration ?? payload.lease_duration ?? incrementSeconds;
    this.scheduleTokenRenewal(ttl);
  }

  stop(): void {
    if (this.tokenRenewTimer) clearTimeout(this.tokenRenewTimer);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token) throw new Error('Vault token is not configured');
    const response = await fetch(`${this.config.address}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Vault-Token': this.token,
        ...(this.config.namespace ? { 'X-Vault-Namespace': this.config.namespace } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`Vault ${method} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<T>;
  }

  private scheduleTokenRenewal(ttlSeconds: number): void {
    if (this.tokenRenewTimer) clearTimeout(this.tokenRenewTimer);
    const renewInMs = Math.max(1000, Math.floor(ttlSeconds * 500));
    this.tokenRenewTimer = setTimeout(() => void this.renewTokenSelf(ttlSeconds), renewInMs);
    this.tokenRenewTimer.unref?.();
  }
}
