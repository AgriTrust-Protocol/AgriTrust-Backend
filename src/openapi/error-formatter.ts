import type { ErrorObject } from 'ajv';

export interface OpenApiValidationErrorItem {
  message: string;
  path: string;
  schemaPath?: string;
  params?: unknown;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  errors?: OpenApiValidationErrorItem[];
}

export function formatOpenApiProblem(
  type: string,
  title: string,
  status: number,
  instance: string,
  errors?: ErrorObject[] | null,
): ProblemDetails {
  return {
    type,
    title,
    status,
    detail: errors && errors.length > 0 ? 'One or more payload fields failed OpenAPI validation.' : title,
    instance,
    errors: errors?.map((error) => ({
      message: error.message ?? 'Validation failed',
      path: error.instancePath ?? '',
      schemaPath: error.schemaPath,
      params: error.params,
    })),
  };
}
