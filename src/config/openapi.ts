import { configLoader } from './loader';

export type OpenApiEnforcementMode = 'strict' | 'warning' | 'off';

export interface OpenApiConfig {
  mode: OpenApiEnforcementMode;
  specPaths: string[];
}

let cached: OpenApiConfig | null = null;

function buildFromConfig(): OpenApiConfig {
  try {
    const cfg = configLoader.config;
    return {
      mode: cfg.openapiEnforcementMode,
      specPaths: cfg.openapiSpecPaths,
    };
  } catch {
    return buildFromEnv();
  }
}

function buildFromEnv(): OpenApiConfig {
  const mode = process.env.OPENAPI_ENFORCEMENT_MODE;
  const normalizedMode: OpenApiEnforcementMode = mode === 'warning' ? 'warning' : mode === 'off' ? 'off' : 'strict';

  const specPaths = process.env.OPENAPI_SPEC_PATHS
    ? process.env.OPENAPI_SPEC_PATHS.split(',').map((path) => path.trim()).filter(Boolean)
    : ['./src/openapi/v1.yaml', './src/openapi/v2.yaml'];

  return { mode: normalizedMode, specPaths };
}

export function getOpenApiConfig(): OpenApiConfig {
  cached = buildFromConfig();
  return cached;
}

configLoader.onChange(() => {
  cached = null;
});

export const openApiConfig: OpenApiConfig = getOpenApiConfig();
