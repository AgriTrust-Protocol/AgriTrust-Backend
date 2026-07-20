import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import YAML from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { configSchema, type AppConfig, redactSensitiveValues } from './schema';

const ajv = new Ajv({ useDefaults: true, coerceTypes: true });
addFormats(ajv);

const validate = ajv.compile(configSchema);

type ConfigListener = (config: AppConfig, previous: AppConfig | null) => void;

interface ConfigHistoryEntry {
  config: AppConfig;
  timestamp: number;
  source: string;
}

function parseEnvVar(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function envToAppConfig(env: Record<string, string | undefined>): Record<string, unknown> {
  return {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    databaseUrl: parseEnvVar(env.DATABASE_URL),
    databasePoolMin: env.DATABASE_POOL_MIN,
    databasePoolMax: env.DATABASE_POOL_MAX,
    mtlsEnabled: env.MTLS_ENABLED,
    mtlsServerKeyPath: parseEnvVar(env.MTLS_SERVER_KEY_PATH),
    mtlsServerCertPath: parseEnvVar(env.MTLS_SERVER_CERT_PATH),
    mtlsCACertPath: parseEnvVar(env.MTLS_CA_CERT_PATH),
    redisUrl: env.REDIS_URL,
    redisPoolMin: env.REDIS_POOL_MIN,
    redisPoolMax: env.REDIS_POOL_MAX,
    logLevel: env.LOG_LEVEL,
    logFormat: env.LOG_FORMAT,
    openapiEnforcementMode: env.OPENAPI_ENFORCEMENT_MODE,
    openapiSpecPaths: env.OPENAPI_SPEC_PATHS
      ? env.OPENAPI_SPEC_PATHS.split(',').map(s => s.trim()).filter(Boolean)
      : undefined,
    uvThreadpoolSize: env.UV_THREADPOOL_SIZE,
    metricsPrefix: env.METRICS_PREFIX,
    healthCheckIntervalMs: env.HEALTH_CHECK_INTERVAL_MS,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    configDir: env.CONFIG_DIR,
    configFile: env.CONFIG_FILE,
    corsOrigins: env.CORS_ORIGINS
      ? env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
      : undefined,
    rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
    rateLimitMax: env.RATE_LIMIT_MAX,
  };
}

function deepFreeze<T extends Record<string, unknown>>(obj: T): T {
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value as Record<string, unknown>);
    }
  }
  return Object.freeze(obj);
}

function computeConfigDiff(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const allKeys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const key of allKeys) {
    if (!(key in previous)) {
      diff[key] = { from: undefined, to: current[key] };
    } else if (!(key in current)) {
      diff[key] = { from: previous[key], to: undefined };
    } else if (previous[key] !== current[key]) {
      diff[key] = { from: previous[key], to: current[key] };
    }
  }
  return diff;
}

export class ConfigLoader {
  private current: AppConfig | null = null;
  private frozen: boolean = false;
  private listeners: Set<ConfigListener> = new Set();
  private watcher: fs.FSWatcher | null = null;
  private envPath: string | null = null;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private configHistory: ConfigHistoryEntry[] = [];
  private readonly maxHistorySize: number;

  private constructor(maxHistorySize: number = 10) {
    this.maxHistorySize = maxHistorySize;
  }

  static create(maxHistorySize?: number): ConfigLoader {
    return new ConfigLoader(maxHistorySize);
  }

  get config(): AppConfig {
    if (!this.current) {
      throw new Error('ConfigLoader has not been initialised. Call load() first.');
    }
    return this.current;
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  getHistory(): readonly ConfigHistoryEntry[] {
    return [...this.configHistory];
  }

  onChange(listener: ConfigListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  freeze(): void {
    this.frozen = true;
    if (this.current) {
      this.current = deepFreeze({ ...this.current } as unknown as Record<string, unknown>) as unknown as AppConfig;
    }
  }

  unfreeze(): void {
    this.frozen = false;
  }

  private notify(previous: AppConfig | null): void {
    for (const listener of this.listeners) {
      try {
        listener(this.current!, previous);
      } catch (err) {
        console.error('[ConfigLoader] listener error:', err);
      }
    }
  }

  private addHistoryEntry(config: AppConfig, source: string): void {
    this.configHistory.push({ config: { ...config }, timestamp: Date.now(), source });
    if (this.configHistory.length > this.maxHistorySize) {
      this.configHistory.shift();
    }
  }

  load(options?: { envPath?: string; env?: Record<string, string | undefined> }): AppConfig {
    if (this.frozen && this.current) {
      throw new Error('ConfigLoader is frozen. Call unfreeze() before making changes.');
    }

    const env = options?.env ?? process.env as Record<string, string | undefined>;
    this.envPath = options?.envPath ?? this.resolveEnvPath();

    const raw = envToAppConfig(env);
    return this.validateAndSet(raw, 'load()');
  }

  private resolveEnvPath(): string {
    const candidates = ['.env', '.env.local', '.env.production', '.env.development'];
    for (const file of candidates) {
      const fullPath = path.resolve(file);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
    return path.resolve('.env');
  }

  loadDotEnv(envPath?: string): AppConfig {
    if (this.frozen && this.current) {
      throw new Error('ConfigLoader is frozen. Call unfreeze() before making changes.');
    }

    const targetPath = envPath ?? this.resolveEnvPath();
    this.envPath = targetPath;

    const envFromFile: Record<string, string> = {};
    if (fs.existsSync(targetPath)) {
      const parsed = dotenv.parse(fs.readFileSync(targetPath, 'utf-8'));
      Object.assign(envFromFile, parsed);
    }

    const merged: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(envFromFile)) {
      merged[key] = value;
    }
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }

    const raw = envToAppConfig(merged);
    return this.validateAndSet(raw, `dotenv:${targetPath}`);
  }

  loadJsonFile(filePath: string): AppConfig {
    if (this.frozen && this.current) {
      throw new Error('ConfigLoader is frozen. Call unfreeze() before making changes.');
    }

    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Config file not found: ${resolvedPath}`);
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`Failed to parse JSON config file ${resolvedPath}: ${(err as Error).message}`);
    }

    this.envPath = resolvedPath;
    return this.validateAndSet(parsed, `json:${resolvedPath}`);
  }

  loadYamlFile(filePath: string): AppConfig {
    if (this.frozen && this.current) {
      throw new Error('ConfigLoader is frozen. Call unfreeze() before making changes.');
    }

    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Config file not found: ${resolvedPath}`);
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    let parsed: Record<string, unknown>;
    try {
      parsed = YAML.parse(content);
    } catch (err) {
      throw new Error(`Failed to parse YAML config file ${resolvedPath}: ${(err as Error).message}`);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`YAML config file ${resolvedPath} did not parse to an object`);
    }

    this.envPath = resolvedPath;
    return this.validateAndSet(parsed, `yaml:${resolvedPath}`);
  }

  loadConfigFile(filePath: string): AppConfig {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
      return this.loadJsonFile(filePath);
    } else if (ext === '.yaml' || ext === '.yml') {
      return this.loadYamlFile(filePath);
    } else {
      return this.loadDotEnv(filePath);
    }
  }

  reload(): AppConfig {
    if (!this.envPath) {
      throw new Error('No config source path available. Call load(), loadDotEnv(), or loadConfigFile() first.');
    }
    return this.loadConfigFile(this.envPath);
  }

  validateConfigObject(obj: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const valid = validate(obj);
    if (!valid) {
      const messages = validate.errors!.map(
        err => `  - ${err.instancePath || '(root)'} ${err.message}${err.params ? ' ' + JSON.stringify(err.params) : ''}`,
      );
      return { valid: false, errors: messages };
    }
    return { valid: true };
  }

  toJSON(): Record<string, unknown> {
    if (!this.current) {
      return {};
    }
    return redactSensitiveValues({ ...this.current }) as unknown as Record<string, unknown>;
  }

  computeDiff(other: AppConfig): Record<string, { from: unknown; to: unknown }> | null {
    if (!this.current) return null;
    return computeConfigDiff(
      this.current as unknown as Record<string, unknown>,
      other as unknown as Record<string, unknown>,
    );
  }

  private validateAndSet(raw: Record<string, unknown>, source: string = 'unknown'): AppConfig {
    const valid = validate(raw);
    if (!valid) {
      const messages = validate.errors!.map(
        err => `  - ${err.instancePath || '(root)'} ${err.message}${err.params ? ' ' + JSON.stringify(err.params) : ''}`,
      );
      throw new Error(`Configuration validation failed:\n${messages.join('\n')}`);
    }

    const cfg = raw as unknown as AppConfig;

    if (cfg.mtlsEnabled) {
      if (!cfg.mtlsServerKeyPath || !cfg.mtlsServerCertPath || !cfg.mtlsCACertPath) {
        throw new Error(
          'Configuration validation failed:\n' +
          '  - MTLS_SERVER_KEY_PATH, MTLS_SERVER_CERT_PATH, and MTLS_CA_CERT_PATH are required when MTLS_ENABLED=true',
        );
      }
    }

    if (cfg.databasePoolMin > cfg.databasePoolMax) {
      throw new Error(
        'Configuration validation failed:\n' +
        '  - DATABASE_POOL_MIN must be <= DATABASE_POOL_MAX',
      );
    }

    if (cfg.redisPoolMin > cfg.redisPoolMax) {
      throw new Error(
        'Configuration validation failed:\n' +
        '  - REDIS_POOL_MIN must be <= REDIS_POOL_MAX',
      );
    }

    const previous = this.current;
    this.current = cfg;
    this.addHistoryEntry(cfg, source);
    this.notify(previous);
    return this.current;
  }

  startHotReload(intervalMs: number = 5000): void {
    if (this.pollingInterval || this.watcher) return;

    if (this.envPath && fs.existsSync(this.envPath)) {
      this.setupFileWatcher(intervalMs);
    }
  }

  private setupFileWatcher(intervalMs: number): void {
    let mtimeMs = fs.statSync(this.envPath!).mtimeMs;

    try {
      this.watcher = fs.watch(this.envPath!, (eventType) => {
        if (eventType === 'change') {
          try {
            if (!fs.existsSync(this.envPath!)) return;
            const currentMtime = fs.statSync(this.envPath!).mtimeMs;
            if (currentMtime > mtimeMs) {
              mtimeMs = currentMtime;
              console.log('[ConfigLoader] Config file changed, reloading...');
              this.loadConfigFile(this.envPath!);
            }
          } catch (err) {
            console.error('[ConfigLoader] file-watch reload error:', err);
          }
        }
      });
      this.watcher.unref();
      console.log('[ConfigLoader] File watcher active for:', this.envPath);
      return;
    } catch {
      this.watcher = null;
    }

    this.startPollingFallback(intervalMs, mtimeMs);
  }

  private startPollingFallback(intervalMs: number, initialMtimeMs: number): void {
    let mtimeMs = initialMtimeMs;

    this.pollingInterval = setInterval(() => {
      try {
        if (!this.envPath || !fs.existsSync(this.envPath)) return;
        const stat = fs.statSync(this.envPath);
        const currentMtime = stat.mtimeMs;
        if (currentMtime > mtimeMs) {
          mtimeMs = currentMtime;
          console.log('[ConfigLoader] Config file changed (polling), reloading...');
          this.loadConfigFile(this.envPath);
        }
      } catch (err) {
        console.error('[ConfigLoader] hot-reload error:', err);
      }
    }, intervalMs);

    this.pollingInterval.unref();
  }

  stopHotReload(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }
}

export const configLoader = ConfigLoader.create();
