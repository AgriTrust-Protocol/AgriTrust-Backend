export type TenantRole = 'farm' | 'aggregator' | 'consumer' | 'auditor' | string;

export interface CertificateTenantIdentity {
  farmId: string;
  tenantId?: string;
  roles: TenantRole[];
  commonName: string;
  subjectAltNames: Record<string, string[]>;
}

export interface TenantRegistryRecord {
  farmId: string;
  tenantId: string;
  schemaName: string;
  roles: TenantRole[];
  enabled?: boolean;
}

export interface ResolvedTenant {
  farmId: string;
  tenantId: string;
  schemaName: string;
  roles: TenantRole[];
  rateLimitClass: 'farm' | 'aggregator';
}

export interface TenantRegistry {
  findByFarmId(farmId: string): Promise<TenantRegistryRecord | undefined> | TenantRegistryRecord | undefined;
}

export class InMemoryTenantRegistry implements TenantRegistry {
  private readonly records = new Map<string, TenantRegistryRecord>();

  constructor(records: TenantRegistryRecord[] = []) {
    for (const record of records) this.upsert(record);
  }

  upsert(record: TenantRegistryRecord): void {
    this.records.set(record.farmId, record);
  }

  findByFarmId(farmId: string): TenantRegistryRecord | undefined {
    return this.records.get(farmId);
  }
}

export class TenantResolutionError extends Error {
  constructor(message: string, public readonly statusCode = 403, public readonly code = 'TENANT_RESOLUTION_FAILED') {
    super(message);
    this.name = 'TenantResolutionError';
  }
}

const FARM_CN_SUFFIX = '.agritrust.io';
const SAFE_SCHEMA = /^[a-z][a-z0-9_]{0,62}$/;

export function farmIdFromCommonName(commonName: string): string {
  const cn = commonName.trim().toLowerCase();
  if (!cn.endsWith(FARM_CN_SUFFIX) || cn.includes('*')) {
    throw new TenantResolutionError('Client certificate CN must be farm_id.agritrust.io', 403, 'CERT_CN_INVALID');
  }

  const farmId = cn.slice(0, -FARM_CN_SUFFIX.length);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(farmId)) {
    throw new TenantResolutionError('Client certificate CN contains an invalid farm id', 403, 'CERT_FARM_ID_INVALID');
  }
  return farmId;
}

export class TenantResolver {
  constructor(private readonly registry: TenantRegistry) {}

  async resolve(identity: CertificateTenantIdentity): Promise<ResolvedTenant> {
    const farmId = identity.farmId || farmIdFromCommonName(identity.commonName);
    const record = await this.registry.findByFarmId(farmId);
    if (!record || record.enabled === false) {
      throw new TenantResolutionError(`No active tenant registry entry for farm ${farmId}`, 403, 'TENANT_NOT_REGISTERED');
    }
    if (identity.tenantId && identity.tenantId !== record.tenantId) {
      throw new TenantResolutionError('Certificate tenant id does not match registry', 403, 'TENANT_ID_MISMATCH');
    }
    if (!SAFE_SCHEMA.test(record.schemaName)) {
      throw new TenantResolutionError('Tenant schema name failed safety validation', 500, 'TENANT_SCHEMA_INVALID');
    }

    const roles = Array.from(new Set([...(record.roles ?? []), ...(identity.roles ?? [])]));
    return {
      farmId,
      tenantId: record.tenantId,
      schemaName: record.schemaName,
      roles,
      rateLimitClass: roles.includes('aggregator') ? 'aggregator' : 'farm',
    };
  }
}
