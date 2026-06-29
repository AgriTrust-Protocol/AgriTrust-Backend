import { RequestHandler } from 'express';
import { versionRegistry } from '../config/api-versions';

export const versionTransformer: RequestHandler = (req, res, next) => {
  const version = req.apiVersion || versionRegistry.getDefaultVersion();
  const config = versionRegistry.getVersionConfig(version);

  if (!config) {
    return next();
  }

  // Request transformations (e.g., v1 -> v2)
  if (req.body && config.requestTransforms.length > 0) {
    for (const transform of config.requestTransforms) {
      req.body = transform(req.body);
    }
  }

  // Response transformations (e.g., v2 -> v1)
  const originalJson = res.json;
  res.json = function (body: any) {
    if (body && config.responseTransforms.length > 0) {
      let transformedBody = body;
      for (const transform of config.responseTransforms) {
        transformedBody = transform(transformedBody);
      }
      return originalJson.call(this, transformedBody);
    }
    return originalJson.call(this, body);
  };

  next();
};
