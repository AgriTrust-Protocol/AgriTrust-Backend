export const RATE_LIMIT_WINDOW_SECONDS = 60;

export const RATE_LIMIT_DEFAULT_MAX = 100;
export const RATE_LIMIT_ADAPTIVE_FLOOR = 10;
export const RATE_LIMIT_ADAPTIVE_CEILING = 500;
export const RATE_LIMIT_MEMORY_BUDGET_BYTES = 8 * 1024;
export const RATE_LIMIT_MAX_WINDOW_ENTRIES = 1_000;

export interface RateLimitPreset {
  windowSeconds: number;
  defaultMax: number;
  tenantKeyPrefix: string;
}

export const certificateIssuanceRateLimit: RateLimitPreset = {
  windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
  defaultMax: RATE_LIMIT_DEFAULT_MAX,
  tenantKeyPrefix: 'rate_limit:certificate_issuance',
};

export const rateLimitPresets = {
  certificateIssuance: certificateIssuanceRateLimit,
} as const;
