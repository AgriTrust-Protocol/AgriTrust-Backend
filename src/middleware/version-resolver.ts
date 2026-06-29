import { RequestHandler } from 'express';
import { versionRegistry } from '../config/api-versions';
import { LRUCache } from '../lib/lru-cache';

const versionCache = new LRUCache<string, string>(10000);
const CACHE_TTL_MS = 300 * 1000; // 300 seconds

function extractVersion(acceptHeader?: string, xVersionHeader?: string): string {
  if (xVersionHeader) {
    return xVersionHeader.toLowerCase();
  }

  if (acceptHeader) {
    const match = acceptHeader.match(/application\/vnd\.agritrust\.(v\d+)\+json/);
    if (match) {
      return match[1].toLowerCase();
    }
  }

  return versionRegistry.getDefaultVersion();
}

export const versionResolver: RequestHandler = (req, res, next) => {
  const acceptHeader = req.headers['accept'] as string | undefined;
  const xVersionHeader = req.headers['x-api-version'] as string | undefined;
  const cacheKey = `${acceptHeader ?? ''}|${xVersionHeader ?? ''}`;

  let resolvedVersion = versionCache.get(cacheKey);

  if (!resolvedVersion) {
    resolvedVersion = extractVersion(acceptHeader, xVersionHeader);
    versionCache.set(cacheKey, resolvedVersion, CACHE_TTL_MS);
  }

  req.apiVersion = resolvedVersion;

  const config = versionRegistry.getVersionConfig(resolvedVersion);
  if (!config) {
    return next();
  }

  if (config.metadata.status === 'deprecated' || config.metadata.status === 'sunset') {
    if (config.metadata.deprecationDate) {
      res.setHeader('Deprecation', `date="${config.metadata.deprecationDate}"`);
    }
    if (config.metadata.sunsetDate) {
      res.setHeader('Sunset', config.metadata.sunsetDate);
    }
    if (config.metadata.migrationUrl) {
      res.setHeader('Link', `<${config.metadata.migrationUrl}>; rel="deprecation"; type="text/html"`);
    }
  }

  // NOTE: Transformation is postponed until AFTER validation if the validator is version-aware.
  // BUT the current openapi-validator expects req.body to match the schema of req.apiVersion.
  // If req.apiVersion is v1, and we transform to v2 (internal), validation will fail against v1 schema.
  // SOLUTION:
  // 1. Resolve Version (req.apiVersion)
  // 2. Validate against req.apiVersion schema.
  // 3. Transform to internal (v2) for the route handler.

  // To do this properly, versionResolver should only resolve.
  // Transformation should be another middleware AFTER openapi-validator.

  next();
};
