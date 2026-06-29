export interface LeaseStatus {
  leaseId: string;
  expiresAt: string;
  ttlSeconds: number;
  renewable: boolean;
}

interface LeaseEntry {
  leaseId: string;
  expiresAt: number;
  ttlSeconds: number;
  renewable: boolean;
  renewTimer?: NodeJS.Timeout;
}

export type LeaseRenewFn = (leaseId: string, incrementSeconds: number) => Promise<{ ttlSeconds: number; renewable: boolean }>;
export type LeaseRenewedHandler = (lease: LeaseStatus) => void | Promise<void>;

export class LeaseManager {
  private readonly leases = new Map<string, LeaseEntry>();

  constructor(
    private readonly renewFn: LeaseRenewFn,
    private readonly onRenewed?: LeaseRenewedHandler,
  ) {}

  track(leaseId: string | undefined, ttlSeconds: number | undefined, renewable = true): void {
    if (!leaseId || !ttlSeconds || ttlSeconds <= 0) return;
    this.clear(leaseId);
    const entry: LeaseEntry = {
      leaseId,
      ttlSeconds,
      renewable,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
    this.leases.set(leaseId, entry);
    this.schedule(entry);
  }

  clear(leaseId: string): void {
    const existing = this.leases.get(leaseId);
    if (existing?.renewTimer) clearTimeout(existing.renewTimer);
    this.leases.delete(leaseId);
  }

  getStatuses(): LeaseStatus[] {
    return [...this.leases.values()].map((entry) => this.toStatus(entry));
  }

  stop(): void {
    for (const lease of this.leases.values()) {
      if (lease.renewTimer) clearTimeout(lease.renewTimer);
    }
    this.leases.clear();
  }

  private schedule(entry: LeaseEntry): void {
    if (!entry.renewable) return;
    const renewDelayMs = Math.max(1000, Math.floor(entry.ttlSeconds * 500));
    entry.renewTimer = setTimeout(() => void this.renew(entry.leaseId), renewDelayMs);
    entry.renewTimer.unref?.();
  }

  private async renew(leaseId: string): Promise<void> {
    const entry = this.leases.get(leaseId);
    if (!entry) return;
    try {
      const renewed = await this.renewFn(leaseId, entry.ttlSeconds);
      entry.ttlSeconds = renewed.ttlSeconds;
      entry.renewable = renewed.renewable;
      entry.expiresAt = Date.now() + renewed.ttlSeconds * 1000;
      if (entry.renewTimer) clearTimeout(entry.renewTimer);
      this.schedule(entry);
      await this.onRenewed?.(this.toStatus(entry));
    } catch (error) {
      console.error(`[Vault] Failed to renew lease ${leaseId}:`, error instanceof Error ? error.message : error);
      this.schedule(entry);
    }
  }

  private toStatus(entry: LeaseEntry): LeaseStatus {
    return {
      leaseId: entry.leaseId,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      ttlSeconds: Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000)),
      renewable: entry.renewable,
    };
  }
}
