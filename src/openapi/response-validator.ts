import { Response, Request } from 'express';
import { formatOpenApiProblem } from './error-formatter';
import { OperationValidators } from './spec-loader';
import { OpenApiEnforcementMode } from '../config/openapi';

function getValidatorForStatus(validators: Map<string, any>, statusCode: number): any | undefined {
  const exact = validators.get(String(statusCode));
  if (exact) {
    return exact;
  }
  return validators.get('default');
}

function buildResponseProblem(
  req: Request,
  errors: any[],
): ReturnType<typeof formatOpenApiProblem> {
  return formatOpenApiProblem(
    'https://example.com/problems/openapi-response-validation',
    'Response validation failed',
    500,
    req.originalUrl,
    errors,
  );
}

export function attachResponseValidator(
  req: Request,
  res: Response,
  validators: OperationValidators,
  mode: OpenApiEnforcementMode,
): void {
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  const validateAndSend = (body: unknown, send: (body: unknown) => Response): Response => {
    const status = res.statusCode || 200;
    const validator = getValidatorForStatus(validators.responseValidators, status);

    if (validator) {
      const valid = validator(body);
      if (!valid) {
        const errors = validator.errors ?? [];

        if (mode === 'strict') {
          res.status(500);
          res.setHeader('x-internal-error', 'true');
          res.setHeader('x-opencode-validation-error', 'true');
          return originalJson(buildResponseProblem(req, errors));
        }

        if (mode === 'warning') {
          res.setHeader('x-opencode-validation-warning', 'true');
          console.warn('OpenAPI response validation warning:', {
            path: req.originalUrl,
            method: req.method,
            status,
            errors,
          });
        }
      }
    }

    return send(body);
  };

  (res as any).json = function (body: unknown): Response {
    return validateAndSend(body, originalJson);
  };

  (res as any).send = function (body: unknown): Response {
    if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) {
      return validateAndSend(body, originalJson);
    }
    return originalSend(body);
  };
}
