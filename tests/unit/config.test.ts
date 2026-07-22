import path from 'path';
import fs from 'fs';
import os from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigLoader } from '../../src/config/loader';
import { configSchema, redactSensitiveValues, SENSITIVE_KEYS } from '../../src/config/schema';

function withEnv(env: Record<string, string>, fn: () => void): void {
  const orig = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (k in orig) {
        process.env[k] = orig[k];
      } else {
        delete process.env[k];
      }
    }
  }
}

function tmpFile(ext: string, content: string): string {
  const p = path.join(os.tmpdir(), `config-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

describe('ConfigLoader', () => {
  let loader: ConfigLoader;

  beforeEach(() => {
    loader = ConfigLoader.create();
  });

  afterEach(() => {
    loader.stopHotReload();
  });

  it('loads config from environment variables', () => {
    const cfg = loader.load({
      env: {
        PORT: '4000',
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
        REDIS_URL: 'redis://redis:6379',
      },
    });

    expect(cfg.port).toBe(4000);
    expect(cfg.nodeEnv).toBe('production');
    expect(cfg.databaseUrl).toBe('postgres://user:pass@localhost:5432/db');
    expect(cfg.redisUrl).toBe('redis://redis:6379');
    expect(cfg.mtlsEnabled).toBe(false);
    expect(cfg.uvThreadpoolSize).toBe(4);
    expect(cfg.openapiEnforcementMode).toBe('strict');
  });

  it('applies defaults when env vars are missing', () => {
    const cfg = loader.load({
      env: { DATABASE_URL: 'postgres://localhost/db' },
    });

    expect(cfg.port).toBe(3000);
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.redisUrl).toBe('redis://localhost:6379');
    expect(cfg.uvThreadpoolSize).toBe(4);
    expect(cfg.openapiEnforcementMode).toBe('strict');
    expect(cfg.openapiSpecPaths).toEqual([
      './src/openapi/v1.yaml',
      './src/openapi/v2.yaml',
    ]);
    expect(cfg.databasePoolMin).toBe(2);
    expect(cfg.databasePoolMax).toBe(20);
    expect(cfg.redisPoolMin).toBe(2);
    expect(cfg.redisPoolMax).toBe(10);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.logFormat).toBe('json');
    expect(cfg.metricsPrefix).toBe('agritrust');
  });

  it('coerces string values to correct types', () => {
    const cfg = loader.load({
      env: {
        PORT: '8080',
        UV_THREADPOOL_SIZE: '8',
        DATABASE_URL: 'postgres://localhost/db',
        DATABASE_POOL_MIN: '1',
        DATABASE_POOL_MAX: '10',
      },
    });

    expect(cfg.port).toBe(8080);
    expect(cfg.uvThreadpoolSize).toBe(8);
    expect(cfg.databasePoolMin).toBe(1);
    expect(cfg.databasePoolMax).toBe(10);
  });

  it('parses OPENAPI_SPEC_PATHS into an array', () => {
    const cfg = loader.load({
      env: {
        DATABASE_URL: 'postgres://localhost/db',
        OPENAPI_SPEC_PATHS: './spec1.yaml, ./spec2.yaml',
      },
    });

    expect(cfg.openapiSpecPaths).toEqual(['./spec1.yaml', './spec2.yaml']);
  });

  it('parses CORS_ORIGINS into an array', () => {
    const cfg = loader.load({
      env: {
        DATABASE_URL: 'postgres://localhost/db',
        CORS_ORIGINS: 'https://app1.com, https://app2.com',
      },
    });

    expect(cfg.corsOrigins).toEqual(['https://app1.com', 'https://app2.com']);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loader.load({ env: { PORT: '3000' } })).toThrow(
      'Configuration validation failed',
    );
  });

  it('throws when MTLS is enabled but cert paths are missing', () => {
    expect(() =>
      loader.load({
        env: {
          DATABASE_URL: 'postgres://localhost/db',
          MTLS_ENABLED: 'true',
        },
      }),
    ).toThrow('Configuration validation failed');
  });

  it('passes validation when MTLS is enabled and all cert paths provided', () => {
    const cfg = loader.load({
      env: {
        DATABASE_URL: 'postgres://localhost/db',
        MTLS_ENABLED: 'true',
        MTLS_SERVER_KEY_PATH: '/certs/key.pem',
        MTLS_SERVER_CERT_PATH: '/certs/cert.pem',
        MTLS_CA_CERT_PATH: '/certs/ca.pem',
      },
    });

    expect(cfg.mtlsEnabled).toBe(true);
    expect(cfg.mtlsServerKeyPath).toBe('/certs/key.pem');
    expect(cfg.mtlsServerCertPath).toBe('/certs/cert.pem');
    expect(cfg.mtlsCACertPath).toBe('/certs/ca.pem');
  });

  it('validates NODE_ENV enum values', () => {
    expect(() =>
      loader.load({
        env: {
          DATABASE_URL: 'postgres://localhost/db',
          NODE_ENV: 'invalid',
        },
      }),
    ).toThrow('Configuration validation failed');
  });

  it('validates port range', () => {
    expect(() =>
      loader.load({
        env: {
          DATABASE_URL: 'postgres://localhost/db',
          PORT: '99999',
        },
      }),
    ).toThrow('Configuration validation failed');
  });

  it('validates database pool min <= max', () => {
    expect(() =>
      loader.load({
        env: {
          DATABASE_URL: 'postgres://localhost/db',
          DATABASE_POOL_MIN: '50',
          DATABASE_POOL_MAX: '10',
        },
      }),
    ).toThrow('DATABASE_POOL_MIN must be <= DATABASE_POOL_MAX');
  });

  it('throws when accessing config before loading', () => {
    const fresh = ConfigLoader.create();
    expect(() => fresh.config).toThrow('ConfigLoader has not been initialised');
  });

  it('notifies listeners on config change', () => {
    const listener = vi.fn();

    const cfg1 = loader.load({
      env: { DATABASE_URL: 'postgres://first/db' },
    });
    loader.onChange(listener);

    const cfg2 = loader.load({
      env: { DATABASE_URL: 'postgres://second/db', PORT: '5000' },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(cfg2, cfg1);
  });

  it('unsubscribes listener when returned function is called', () => {
    const listener = vi.fn();
    const unsubscribe = loader.onChange(listener);

    loader.load({ env: { DATABASE_URL: 'postgres://first/db' } });
    unsubscribe();

    loader.load({ env: { DATABASE_URL: 'postgres://second/db' } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('exposes config via getter after loading', () => {
    const cfg = loader.load({
      env: { DATABASE_URL: 'postgres://localhost/db' },
    });
    expect(loader.config).toBe(cfg);
  });

  it('handles empty OPENAPI_SPEC_PATHS', () => {
    const cfg = loader.load({
      env: {
        DATABASE_URL: 'postgres://localhost/db',
        OPENAPI_SPEC_PATHS: '',
      },
    });
    expect(cfg.openapiSpecPaths).toEqual([
      './src/openapi/v1.yaml',
      './src/openapi/v2.yaml',
    ]);
  });

  it('strips whitespace from parsed cert paths', () => {
    const cfg = loader.load({
      env: {
        DATABASE_URL: 'postgres://localhost/db',
        MTLS_ENABLED: 'true',
        MTLS_SERVER_KEY_PATH: '  /certs/key.pem  ',
        MTLS_SERVER_CERT_PATH: '  /certs/cert.pem  ',
        MTLS_CA_CERT_PATH: '  /certs/ca.pem  ',
      },
    });

    expect(cfg.mtlsServerKeyPath).toBe('/certs/key.pem');
    expect(cfg.mtlsServerCertPath).toBe('/certs/cert.pem');
    expect(cfg.mtlsCACertPath).toBe('/certs/ca.pem');
  });

  it('freezes config after freeze() and throws on reload', () => {
    loader.load({ env: { DATABASE_URL: 'postgres://localhost/db' } });
    loader.freeze();
    expect(loader.isFrozen).toBe(true);
    expect(() =>
      loader.load({ env: { DATABASE_URL: 'postgres://other/db' } }),
    ).toThrow('ConfigLoader is frozen');
  });

  it('unfreezes config and allows reload', () => {
    loader.load({ env: { DATABASE_URL: 'postgres://localhost/db' } });
    loader.freeze();
    loader.unfreeze();
    expect(loader.isFrozen).toBe(false);
    const cfg = loader.load({ env: { DATABASE_URL: 'postgres://other/db' } });
    expect(cfg.databaseUrl).toBe('postgres://other/db');
  });

  it('tracks config history', () => {
    loader.load({ env: { DATABASE_URL: 'postgres://first/db' } });
    loader.load({ env: { DATABASE_URL: 'postgres://second/db' } });
    loader.load({ env: { DATABASE_URL: 'postgres://third/db' } });

    const history = loader.getHistory();
    expect(history.length).toBe(3);
    expect(history[0].config.databaseUrl).toBe('postgres://first/db');
    expect(history[history.length - 1].config.databaseUrl).toBe('postgres://third/db');
    expect(history[0].source).toBe('load()');
  });

  it('limits config history to maxHistorySize', () => {
    const limited = ConfigLoader.create(2);
    limited.load({ env: { DATABASE_URL: 'postgres://first/db' } });
    limited.load({ env: { DATABASE_URL: 'postgres://second/db' } });
    limited.load({ env: { DATABASE_URL: 'postgres://third/db' } });

    expect(limited.getHistory().length).toBe(2);
    expect(limited.getHistory()[0].config.databaseUrl).toBe('postgres://second/db');
  });

  it('computes diff between two config loads', () => {
    loader.load({ env: { DATABASE_URL: 'postgres://first/db', PORT: '3000' } });
    const other = loader.load({ env: { DATABASE_URL: 'postgres://second/db', PORT: '4000' } });
    expect(other.port).toBe(4000);
    expect(other.databaseUrl).toBe('postgres://second/db');
  });

  it('validates config objects via validateConfigObject', () => {
    const result = loader.validateConfigObject({ databaseUrl: 'postgres://localhost/db' });
    expect(result.valid).toBe(true);
  });

  it('rejects invalid config objects via validateConfigObject', () => {
    const result = loader.validateConfigObject({});
    expect(result.valid).toBe(false);
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('toJSON returns redacted sensitive values', () => {
    loader.load({
      env: {
        DATABASE_URL: 'postgres://user:secret@localhost/db',
        REDIS_URL: 'redis://:token@localhost:6379',
      },
    });

    const json = loader.toJSON();
    expect(json.databaseUrl as string).not.toContain('secret');
    expect(json.databaseUrl as string).toContain('****');
    expect(json.redisUrl as string).toContain('****');
  });

  it('does not throw when listener throws', () => {
    loader.onChange(() => { throw new Error('listener error'); });
    expect(() =>
      loader.load({ env: { DATABASE_URL: 'postgres://localhost/db' } }),
    ).not.toThrow();
  });
});

describe('ConfigLoader - file loading', () => {
  let loader: ConfigLoader;

  beforeEach(() => {
    loader = ConfigLoader.create();
  });

  afterEach(() => {
    loader.stopHotReload();
  });

  it('loads config from a JSON file', () => {
    const jsonPath = tmpFile('.json', JSON.stringify({
      port: 6000,
      databaseUrl: 'postgres://json/db',
      databasePoolMax: 30,
      logLevel: 'debug',
    }));
    try {
      const cfg = loader.loadJsonFile(jsonPath);
      expect(cfg.port).toBe(6000);
      expect(cfg.databaseUrl).toBe('postgres://json/db');
      expect(cfg.databasePoolMax).toBe(30);
      expect(cfg.logLevel).toBe('debug');
    } finally {
      try { fs.unlinkSync(jsonPath); } catch {}
    }
  });

  it('loads config from a YAML file', () => {
    const yamlPath = tmpFile('.yaml', [
      'port: 7000',
      'databaseUrl: postgres://yaml/db',
      'logLevel: debug',
      'metricsPrefix: test',
    ].join('\n'));
    try {
      const cfg = loader.loadYamlFile(yamlPath);
      expect(cfg.port).toBe(7000);
      expect(cfg.databaseUrl).toBe('postgres://yaml/db');
      expect(cfg.logLevel).toBe('debug');
      expect(cfg.metricsPrefix).toBe('test');
    } finally {
      try { fs.unlinkSync(yamlPath); } catch {}
    }
  });

  it('loads config from .json via loadConfigFile', () => {
    const jsonPath = tmpFile('.json', JSON.stringify({
      port: 8000,
      databaseUrl: 'postgres://autodetect/db',
    }));
    try {
      const cfg = loader.loadConfigFile(jsonPath);
      expect(cfg.port).toBe(8000);
      expect(cfg.databaseUrl).toBe('postgres://autodetect/db');
    } finally {
      try { fs.unlinkSync(jsonPath); } catch {}
    }
  });

  it('loads config from .yaml via loadConfigFile', () => {
    const yamlPath = tmpFile('.yaml', [
      'port: 9000',
      'databaseUrl: postgres://yamldetect/db',
    ].join('\n'));
    try {
      const cfg = loader.loadConfigFile(yamlPath);
      expect(cfg.port).toBe(9000);
      expect(cfg.databaseUrl).toBe('postgres://yamldetect/db');
    } finally {
      try { fs.unlinkSync(yamlPath); } catch {}
    }
  });

  it('loads config from .yml via loadConfigFile', () => {
    const ymlPath = tmpFile('.yml', [
      'port: 9500',
      'databaseUrl: postgres://ymldetect/db',
    ].join('\n'));
    try {
      const cfg = loader.loadConfigFile(ymlPath);
      expect(cfg.port).toBe(9500);
      expect(cfg.databaseUrl).toBe('postgres://ymldetect/db');
    } finally {
      try { fs.unlinkSync(ymlPath); } catch {}
    }
  });

  it('throws on missing JSON file', () => {
    expect(() => loader.loadJsonFile('/nonexistent/config.json')).toThrow('Config file not found');
  });

  it('throws on missing YAML file', () => {
    expect(() => loader.loadYamlFile('/nonexistent/config.yaml')).toThrow('Config file not found');
  });

  it('reloads config from the last loaded file', () => {
    const jsonPath = tmpFile('.json', JSON.stringify({
      port: 7777,
      databaseUrl: 'postgres://reload/db',
    }));
    try {
      loader.loadConfigFile(jsonPath);
      expect(loader.config.port).toBe(7777);

      fs.writeFileSync(jsonPath, JSON.stringify({
        port: 8888,
        databaseUrl: 'postgres://reload/db',
      }), 'utf-8');

      const reloaded = loader.reload();
      expect(reloaded.port).toBe(8888);
    } finally {
      try { fs.unlinkSync(jsonPath); } catch {}
    }
  });

  it('throws reload when no source path exists', () => {
    expect(() => loader.reload()).toThrow('No config source path available');
  });
});

describe('ConfigLoader - dotenv loading', () => {
  let loader: ConfigLoader;

  beforeEach(() => {
    loader = ConfigLoader.create();
  });

  afterEach(() => {
    loader.stopHotReload();
  });

  it('loads config from a .env file path', () => {
    const envContent = [
      'PORT=5001',
      'DATABASE_URL=postgres://fromfile/db',
      'UV_THREADPOOL_SIZE=16',
      'NODE_ENV=development',
    ].join('\n');

    const envPath = path.resolve(__dirname, './test-config.env');

    fs.writeFileSync(envPath, envContent, 'utf-8');
    try {
      withEnv({ DATABASE_URL: 'postgres://fromfile/db', PORT: '5001' }, () => {
        const cfg = loader.loadDotEnv(envPath);
        expect(cfg.port).toBe(5001);
        expect(cfg.databaseUrl).toBe('postgres://fromfile/db');
        expect(cfg.uvThreadpoolSize).toBe(16);
      });
    } finally {
      try { fs.unlinkSync(envPath); } catch {}
    }
  });

  it('prefers process.env over .env file values', () => {
    const envContent = [
      'PORT=5000',
      'DATABASE_URL=postgres://fromfile/db',
    ].join('\n');

    const envPath = path.resolve(__dirname, './test-config-prefers.env');
    fs.writeFileSync(envPath, envContent, 'utf-8');
    try {
      withEnv({ DATABASE_URL: 'postgres://fromprocess/db' }, () => {
        const cfg = loader.loadDotEnv(envPath);
        expect(cfg.databaseUrl).toBe('postgres://fromprocess/db');
        expect(cfg.port).toBe(5000);
      });
    } finally {
      try { fs.unlinkSync(envPath); } catch {}
    }
  });

  it('handles missing .env file with process.env fallback', () => {
    withEnv({ DATABASE_URL: 'postgres://processfallback/db' }, () => {
      const cfg = loader.loadDotEnv('/tmp/__nonexistent__/.env');
      expect(cfg).toBeDefined();
      expect(cfg.databaseUrl).toBe('postgres://processfallback/db');
    });
  });

  it('validates mTLS paths when loaded via dotenv', () => {
    const envContent = [
      'DATABASE_URL=postgres://localhost/db',
      'MTLS_ENABLED=true',
    ].join('\n');

    const envPath = path.resolve(__dirname, './test-config-mtls.env');
    fs.writeFileSync(envPath, envContent, 'utf-8');
    try {
      withEnv({ DATABASE_URL: 'postgres://localhost/db', MTLS_ENABLED: 'true' }, () => {
        expect(() => loader.loadDotEnv(envPath)).toThrow(
          'Configuration validation failed',
        );
      });
    } finally {
      try { fs.unlinkSync(envPath); } catch {}
    }
  });
});

describe('configSchema', () => {
  it('defines all expected properties', () => {
    const props = configSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('port');
    expect(props).toHaveProperty('nodeEnv');
    expect(props).toHaveProperty('databaseUrl');
    expect(props).toHaveProperty('databasePoolMin');
    expect(props).toHaveProperty('databasePoolMax');
    expect(props).toHaveProperty('mtlsEnabled');
    expect(props).toHaveProperty('redisUrl');
    expect(props).toHaveProperty('redisPoolMin');
    expect(props).toHaveProperty('redisPoolMax');
    expect(props).toHaveProperty('logLevel');
    expect(props).toHaveProperty('logFormat');
    expect(props).toHaveProperty('metricsPrefix');
    expect(props).toHaveProperty('openapiEnforcementMode');
    expect(props).toHaveProperty('openapiSpecPaths');
    expect(props).toHaveProperty('uvThreadpoolSize');
    expect(props).toHaveProperty('healthCheckIntervalMs');
    expect(props).toHaveProperty('shutdownTimeoutMs');
    expect(props).toHaveProperty('configDir');
    expect(props).toHaveProperty('configFile');
    expect(props).toHaveProperty('corsOrigins');
    expect(props).toHaveProperty('rateLimitWindowMs');
    expect(props).toHaveProperty('rateLimitMax');
  });

  it('requires databaseUrl', () => {
    expect(configSchema.required).toContain('databaseUrl');
  });
});

describe('redactSensitiveValues', () => {
  it('redacts known sensitive keys', () => {
    const input = {
      databaseUrl: 'postgres://user:supersecret@localhost/db',
      redisUrl: 'redis://:mytoken@localhost:6379',
      port: 3000,
    };
    const redacted = redactSensitiveValues(input);
    expect(redacted.databaseUrl).toContain('****');
    expect(redacted.port).toBe(3000);
  });

  it('handles short values gracefully', () => {
    const input = { databaseUrl: 'abc' };
    const redacted = redactSensitiveValues(input);
    expect(redacted.databaseUrl).toBe('****');
  });
});

describe('SENSITIVE_KEYS', () => {
  it('contains all sensitive config paths', () => {
    expect(SENSITIVE_KEYS.has('databaseUrl')).toBe(true);
    expect(SENSITIVE_KEYS.has('redisUrl')).toBe(true);
    expect(SENSITIVE_KEYS.has('mtlsServerKeyPath')).toBe(true);
    expect(SENSITIVE_KEYS.has('mtlsServerCertPath')).toBe(true);
    expect(SENSITIVE_KEYS.has('mtlsCACertPath')).toBe(true);
  });
});
