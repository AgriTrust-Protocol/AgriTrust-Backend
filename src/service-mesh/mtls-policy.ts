export type MeshProvider = 'istio' | 'linkerd' | 'consul' | 'none';
export type MtlsMode = 'STRICT' | 'PERMISSIVE' | 'DISABLED';

export interface ServiceMeshPolicyInput {
  enabled?: boolean;
  provider?: MeshProvider;
  namespace?: string;
  serviceName?: string;
  mtlsMode?: MtlsMode;
  criticalPathP99TargetMs?: number;
  availabilityTarget?: number;
  canary?: {
    enabled?: boolean;
    initialWeightPercent?: number;
    maxWeightPercent?: number;
    errorRateThresholdPercent?: number;
    p99LatencyThresholdMs?: number;
  };
}

export interface ServiceMeshPolicy {
  enabled: boolean;
  provider: MeshProvider;
  namespace: string;
  serviceName: string;
  mtlsMode: MtlsMode;
  criticalPathP99TargetMs: number;
  availabilityTarget: number;
  canary: {
    enabled: boolean;
    initialWeightPercent: number;
    maxWeightPercent: number;
    errorRateThresholdPercent: number;
    p99LatencyThresholdMs: number;
  };
  securityReviewRequired: true;
}

const DEFAULT_POLICY: ServiceMeshPolicy = {
  enabled: true,
  provider: 'istio',
  namespace: 'agritrust',
  serviceName: 'agritrust-backend',
  mtlsMode: 'STRICT',
  criticalPathP99TargetMs: 100,
  availabilityTarget: 99.99,
  canary: {
    enabled: true,
    initialWeightPercent: 5,
    maxWeightPercent: 50,
    errorRateThresholdPercent: 1,
    p99LatencyThresholdMs: 100,
  },
  securityReviewRequired: true,
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseProvider(value: string | undefined, fallback: MeshProvider): MeshProvider {
  const normalized = value?.toLowerCase();
  if (normalized === 'istio' || normalized === 'linkerd' || normalized === 'consul' || normalized === 'none') {
    return normalized;
  }
  return fallback;
}

function parseMtlsMode(value: string | undefined, fallback: MtlsMode): MtlsMode {
  const normalized = value?.toUpperCase();
  if (normalized === 'STRICT' || normalized === 'PERMISSIVE' || normalized === 'DISABLED') {
    return normalized;
  }
  return fallback;
}

export function createServiceMeshPolicy(input: ServiceMeshPolicyInput = {}): ServiceMeshPolicy {
  const policy: ServiceMeshPolicy = {
    ...DEFAULT_POLICY,
    ...input,
    canary: {
      ...DEFAULT_POLICY.canary,
      ...input.canary,
    },
    securityReviewRequired: true,
  };

  if (policy.enabled && policy.mtlsMode !== 'STRICT') {
    throw new Error('Service mesh mTLS must be STRICT when the mesh is enabled.');
  }
  if (policy.criticalPathP99TargetMs > 100) {
    throw new Error('Critical path P99 target must be <= 100ms.');
  }
  if (policy.availabilityTarget < 99.99) {
    throw new Error('Availability target must be at least 99.99%.');
  }
  if (policy.canary.initialWeightPercent < 1 || policy.canary.initialWeightPercent > policy.canary.maxWeightPercent) {
    throw new Error('Canary initial weight must be between 1 and the max canary weight.');
  }
  if (policy.canary.p99LatencyThresholdMs > policy.criticalPathP99TargetMs) {
    throw new Error('Canary latency threshold cannot exceed the critical path P99 target.');
  }

  return policy;
}

export function getServiceMeshPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceMeshPolicy {
  return createServiceMeshPolicy({
    enabled: parseBoolean(env.SERVICE_MESH_ENABLED, DEFAULT_POLICY.enabled),
    provider: parseProvider(env.SERVICE_MESH_PROVIDER, DEFAULT_POLICY.provider),
    namespace: env.SERVICE_MESH_NAMESPACE || DEFAULT_POLICY.namespace,
    serviceName: env.SERVICE_MESH_SERVICE_NAME || DEFAULT_POLICY.serviceName,
    mtlsMode: parseMtlsMode(env.SERVICE_MESH_MTLS_MODE, DEFAULT_POLICY.mtlsMode),
    criticalPathP99TargetMs: parseNumber(env.SERVICE_MESH_P99_TARGET_MS, DEFAULT_POLICY.criticalPathP99TargetMs),
    availabilityTarget: parseNumber(env.SERVICE_MESH_AVAILABILITY_TARGET, DEFAULT_POLICY.availabilityTarget),
    canary: {
      enabled: parseBoolean(env.SERVICE_MESH_CANARY_ENABLED, DEFAULT_POLICY.canary.enabled),
      initialWeightPercent: parseNumber(env.SERVICE_MESH_CANARY_INITIAL_WEIGHT, DEFAULT_POLICY.canary.initialWeightPercent),
      maxWeightPercent: parseNumber(env.SERVICE_MESH_CANARY_MAX_WEIGHT, DEFAULT_POLICY.canary.maxWeightPercent),
      errorRateThresholdPercent: parseNumber(env.SERVICE_MESH_CANARY_ERROR_RATE_THRESHOLD, DEFAULT_POLICY.canary.errorRateThresholdPercent),
      p99LatencyThresholdMs: parseNumber(env.SERVICE_MESH_CANARY_P99_THRESHOLD_MS, DEFAULT_POLICY.canary.p99LatencyThresholdMs),
    },
  });
}

export function serviceMeshReadiness(policy: ServiceMeshPolicy): { ready: boolean; checks: Record<string, boolean> } {
  const checks = {
    meshEnabled: policy.enabled,
    strictMtls: policy.mtlsMode === 'STRICT',
    p99TargetMet: policy.criticalPathP99TargetMs <= 100,
    availabilityTargetMet: policy.availabilityTarget >= 99.99,
    canaryGuardrailsConfigured: policy.canary.enabled && policy.canary.p99LatencyThresholdMs <= policy.criticalPathP99TargetMs,
    securityReviewRequired: policy.securityReviewRequired,
  };

  return {
    ready: Object.values(checks).every(Boolean),
    checks,
  };
}
