export type FeatureFlagState = 'enabled' | 'disabled' | 'shadow';

export interface FeatureFlagDefinition {
  name: string;
  description: string;
  defaultState: FeatureFlagState;
  critical?: boolean;
}

export interface FeatureFlagEvaluation {
  name: string;
  enabled: boolean;
  state: FeatureFlagState;
  source: 'override' | 'environment' | 'default';
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);

export class FeatureFlagRegistry {
  private readonly definitions = new Map<string, FeatureFlagDefinition>();
  private readonly overrides = new Map<string, FeatureFlagState>();

  constructor(definitions: FeatureFlagDefinition[] = DEFAULT_FEATURE_FLAGS) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: FeatureFlagDefinition): void {
    if (!definition.name.match(/^[a-z][a-z0-9_.-]*$/)) {
      throw new Error(`Invalid feature flag name: ${definition.name}`);
    }
    this.definitions.set(definition.name, definition);
  }

  setOverride(name: string, state: FeatureFlagState): void {
    this.assertKnown(name);
    this.overrides.set(name, state);
  }

  clearOverride(name: string): void {
    this.overrides.delete(name);
  }

  evaluate(name: string, env: NodeJS.ProcessEnv = process.env): FeatureFlagEvaluation {
    const definition = this.assertKnown(name);
    const override = this.overrides.get(name);
    if (override) {
      return this.toEvaluation(name, override, 'override');
    }

    const envValue = env[this.envKey(name)];
    const parsed = envValue === undefined ? undefined : parseFeatureFlagState(envValue);
    if (parsed) {
      return this.toEvaluation(name, parsed, 'environment');
    }

    return this.toEvaluation(name, definition.defaultState, 'default');
  }

  snapshot(env: NodeJS.ProcessEnv = process.env): Record<string, FeatureFlagEvaluation> {
    return Object.fromEntries(
      [...this.definitions.keys()].map((name) => [name, this.evaluate(name, env)]),
    );
  }

  private assertKnown(name: string): FeatureFlagDefinition {
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new Error(`Unknown feature flag: ${name}`);
    }
    return definition;
  }

  private envKey(name: string): string {
    return `FEATURE_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  }

  private toEvaluation(
    name: string,
    state: FeatureFlagState,
    source: FeatureFlagEvaluation['source'],
  ): FeatureFlagEvaluation {
    return { name, state, source, enabled: state === 'enabled' };
  }
}

export function parseFeatureFlagState(value: string): FeatureFlagState | undefined {
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return 'enabled';
  if (FALSE_VALUES.has(normalized)) return 'disabled';
  if (normalized === 'shadow') return 'shadow';
  return undefined;
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlagDefinition[] = [
  {
    name: 'certification.minting',
    description: 'Controls certificate minting against the ledger.',
    defaultState: 'enabled',
    critical: true,
  },
  {
    name: 'telemetry.enrichment',
    description: 'Controls non-critical telemetry enrichment and transformation.',
    defaultState: 'enabled',
  },
  {
    name: 'webhook.delivery',
    description: 'Controls outbound webhook fan-out.',
    defaultState: 'enabled',
  },
];

export const featureFlags = new FeatureFlagRegistry();
