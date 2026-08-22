import { RequestHandler } from 'express';
import { openApiConfig } from '../config/openapi';
import { getOperationValidators } from '../openapi/spec-loader';
import { formatOpenApiProblem } from '../openapi/error-formatter';
import { attachResponseValidator } from '../openapi/response-validator';

function normalizeRequestHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return Object.entries(headers).reduce(
    (result, [key, value]) => {
      result[key.toLowerCase()] = value;
      return result;
    },
    {} as Record<string, unknown>,
  );
}

function extractPathParams(urlPath: string, pattern: string): Record<string, string> {
  const patternParts = pattern.split('/');
  const urlParts = urlPath.split('/');
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = urlParts[i] ?? '';
    }
  }
  return params;
}

function buildRequestPayload(req: any, routePattern: string): Record<string, unknown> {
  const fullPath = (req.baseUrl ?? '') + req.path;
  const pathParams =
    Object.keys(req.params ?? {}).length > 0
      ? req.params
      : extractPathParams(fullPath, routePattern);
  return {
    path: pathParams,
    query: req.query ?? {},
    header: normalizeRequestHeaders(req.headers ?? {}),
    body: req.body,
  };
}

export const openApiValidationMiddleware: RequestHandler = async (req, res, next) => {
  if (openApiConfig.mode === 'off') {
    return next();
  }

  let validators;

  try {
    validators = await getOperationValidators(req);
  } catch (error) {
    return next(error);
  }

  if (!validators) {
    return next();
  }

  if (validators.requestValidator) {
    const payload = buildRequestPayload(req, validators.routePattern);
    const valid = validators.requestValidator(payload);

    if (!valid) {
      const problem = formatOpenApiProblem(
        'https://example.com/problems/openapi-request-validation',
        'Request validation failed',
        400,
        req.originalUrl,
        validators.requestValidator.errors,
      );

      if (openApiConfig.mode === 'strict') {
        res.setHeader('x-opencode-validation-error', 'true');
        return res.status(400).json(problem);
      }

      if (openApiConfig.mode === 'warning') {
        res.setHeader('x-opencode-validation-warning', 'true');
        console.warn('OpenAPI request validation warning:', {
          path: req.originalUrl,
          method: req.method,
          errors: validators.requestValidator.errors,
        });
      }
    }
  }

  attachResponseValidator(req, res, validators, openApiConfig.mode);
  return next();
};
