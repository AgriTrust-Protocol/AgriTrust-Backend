import path from 'path';
import RefParser from '@apidevtools/json-schema-ref-parser';
import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { Request } from 'express';
import type { OpenAPIV3 } from 'openapi-types';
import { openApiConfig } from '../config/openapi';
import { LRUCache } from '../lib/lru-cache';

export interface OperationValidators {
  requestValidator?: ValidateFunction;
  responseValidators: Map<string, ValidateFunction>;
}

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true, verbose: false });
addFormats(ajv);
const schemaCache = new LRUCache<string, ValidateFunction>(10000);
const mergedDocuments = new Map<string, OpenAPIV3.Document>();
const versionedRouteEntries = new Map<string, RouteEntry[]>();
let initialized = false;

async function loadOpenApiDocument(specPath: string): Promise<OpenAPIV3.Document> {
  const absolutePath = path.resolve(process.cwd(), specPath);
  const dereferenced = (await RefParser.dereference(absolutePath)) as unknown as OpenAPIV3.Document;

  if (!dereferenced.openapi) {
    throw new Error(`OpenAPI specification at ${specPath} is invalid or missing openapi version.`);
  }

  return dereferenced;
}

function mergeOpenApiDocuments(documents: OpenAPIV3.Document[]): OpenAPIV3.Document {
  const merged: OpenAPIV3.Document = {
    openapi: documents[0]?.openapi ?? '3.1.0',
    info: documents[0]?.info ?? { title: 'Merged OpenAPI', version: '1.0.0' },
    paths: {},
    components: {},
  };

  for (const document of documents) {
    merged.paths = { ...merged.paths, ...document.paths };
    merged.components = { ...merged.components, ...document.components };
  }

  return merged;
}

function compileSchema(schema: object): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = schemaCache.get(key);
  if (cached) {
    return cached;
  }

  const validator = ajv.compile(schema);
  schemaCache.set(key, validator);
  return validator;
}

function normalizeRouterPath(openApiPath: string): string {
  return openApiPath.replace(/\{([^}]+)\}/g, ':$1');
}

function routePatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/:[^/]+/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

function buildParametersSchema(parameters: OpenAPIV3.ParameterObject[] = []): OpenAPIV3.SchemaObject | undefined {
  const locations: Record<string, { type: 'object'; properties: Record<string, unknown>; required: string[]; } & { additionalProperties?: boolean }> = {
    path: { type: 'object', properties: {}, required: [] },
    query: { type: 'object', properties: {}, required: [], additionalProperties: true },
    header: { type: 'object', properties: {}, required: [], additionalProperties: true },
  };

  let hasParameters = false;

  for (const parameter of parameters) {
    if (!parameter || parameter.in === undefined) {
      continue;
    }

    const location = parameter.in;
    const schema = parameter.schema ?? { type: 'string' };
    const name = location === 'header' ? (parameter.name || '').toLowerCase() : parameter.name;
    if (!name) {
      continue;
    }

    hasParameters = true;
    locations[location].properties[name] = schema;
    if (parameter.required) {
      locations[location].required.push(name);
    }
  }

  if (!hasParameters) {
    return undefined;
  }

  const container: any = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };

  for (const location of ['path', 'query', 'header']) {
    if (Object.keys(locations[location].properties).length > 0) {
      container.properties[location] = {
        type: 'object',
        properties: locations[location].properties,
        additionalProperties: location === 'path' ? false : true,
      };
      if (locations[location].required.length > 0) {
        container.properties[location].required = locations[location].required;
      }
    }
  }

  return container;
}

function extractJsonSchemaFromRequestBody(requestBody?: OpenAPIV3.RequestBodyObject): OpenAPIV3.SchemaObject | undefined {
  if (!requestBody || !requestBody.content) {
    return undefined;
  }

  const bodyContent = requestBody.content['application/json'] ?? requestBody.content['*/*'] ?? Object.values(requestBody.content)[0];
  return (bodyContent as OpenAPIV3.MediaTypeObject)?.schema as OpenAPIV3.SchemaObject | undefined;
}

function extractJsonSchemaFromResponse(response: OpenAPIV3.ResponseObject): OpenAPIV3.SchemaObject | undefined {
  if (!response.content) {
    return undefined;
  }
  const bodyContent = response.content['application/json'] ?? response.content['*/*'] ?? Object.values(response.content)[0];
  return (bodyContent as OpenAPIV3.MediaTypeObject)?.schema as OpenAPIV3.SchemaObject | undefined;
}

function buildRequestValidator(operation: OpenAPIV3.OperationObject, pathParameters: (OpenAPIV3.ParameterObject | OpenAPIV3.ReferenceObject)[]): ValidateFunction | undefined {
  const parameters = [...(pathParameters as OpenAPIV3.ParameterObject[]), ...(operation.parameters as OpenAPIV3.ParameterObject[] ?? [])].filter(
    (param) => !!param && (param as OpenAPIV3.ParameterObject).in,
  ) as OpenAPIV3.ParameterObject[];

  const parameterSchema = buildParametersSchema(parameters);
  const bodySchema = extractJsonSchemaFromRequestBody(operation.requestBody as OpenAPIV3.RequestBodyObject);
  const schema: any = {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };

  if (parameterSchema) {
    schema.properties = { ...schema.properties, ...parameterSchema.properties };
    const pathProp = (parameterSchema.properties as Record<string, any> | undefined)?.path;
    if (pathProp && Array.isArray(pathProp.required) && pathProp.required.length > 0) {
      schema.required = schema.required ?? [];
      schema.required.push('path');
    }
  }

  if (bodySchema) {
    schema.properties.body = bodySchema;
    if ((operation.requestBody as OpenAPIV3.RequestBodyObject)?.required) {
      schema.required = schema.required ?? [];
      schema.required.push('body');
    }
  }

  if (!Object.keys(schema.properties).length) {
    return undefined;
  }

  return compileSchema(schema);
}

function buildResponseValidators(operation: OpenAPIV3.OperationObject): Map<string, ValidateFunction> {
  const validators = new Map<string, ValidateFunction>();

  if (!operation.responses) {
    return validators;
  }

  for (const [statusCode, response] of Object.entries(operation.responses)) {
    const resolvedResponse = response as OpenAPIV3.ResponseObject;
    const schema = extractJsonSchemaFromResponse(resolvedResponse);
    if (!schema) {
      continue;
    }
    validators.set(statusCode, compileSchema(schema));
  }

  return validators;
}

interface RouteEntry {
  method: string;
  pattern: string;
  regex: RegExp;
  validators: OperationValidators;
}

const routeEntries: RouteEntry[] = [];

export interface MatchedValidators extends OperationValidators {
  routePattern: string;
}

function findValidatorsForRequest(req: Request): MatchedValidators | undefined {
  const method = req.method.toUpperCase();
  const fullPath = (req.baseUrl ?? '') + req.path;
  for (const entry of routeEntries) {
    if (entry.method === method && entry.regex.test(fullPath)) {
      return { ...entry.validators, routePattern: entry.pattern };
    }
  }
  return undefined;
}

async function initializeOpenApi(): Promise<void> {
  if (initialized) {
    return;
  }

  for (const specPath of openApiConfig.specPaths) {
    const doc = await loadOpenApiDocument(specPath);
    const versionMatch = specPath.match(/(v\d+)\.yaml$/);
    const version = versionMatch ? versionMatch[1] : 'v2';

    mergedDocuments.set(version, doc);

    const paths = doc.paths ?? {};
    const supportedMethods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
    const entries: RouteEntry[] = [];

    for (const [openApiPath, pathItem] of Object.entries(paths)) {
      if (!pathItem) {
        continue;
      }

      const normalizedPath = normalizeRouterPath(openApiPath);
      const pathParameters = pathItem.parameters as OpenAPIV3.ParameterObject[] ?? [];

      for (const method of supportedMethods) {
        const operation = (pathItem as any)[method] as OpenAPIV3.OperationObject | undefined;
        if (!operation) {
          continue;
        }

        const customRouterPath = (operation as any)['x-router-path'] ?? (pathItem as any)['x-router-path'];
        const routerPath = typeof customRouterPath === 'string' ? customRouterPath : normalizedPath;
        const requestValidator = buildRequestValidator(operation, pathParameters);
        const responseValidators = buildResponseValidators(operation);

        entries.push({
          method: method.toUpperCase(),
          pattern: routerPath,
          regex: routePatternToRegex(routerPath),
          validators: { requestValidator, responseValidators },
        });
      }
    }
    versionedRouteEntries.set(version, entries);
  }

  initialized = true;
}

export async function getMergedOpenApiDocument(version: string = 'v2'): Promise<OpenAPIV3.Document> {
  if (!initialized) {
    await initializeOpenApi();
  }

  return (mergedDocuments.get(version) || mergedDocuments.get('v2')) as OpenAPIV3.Document;
}

export async function getOperationValidators(req: Request): Promise<MatchedValidators | undefined> {
  if (!initialized) {
    await initializeOpenApi();
  }

  const version = req.apiVersion || 'v2';
  const entries = versionedRouteEntries.get(version) || versionedRouteEntries.get('v2') || [];

  const method = req.method.toUpperCase();
  const fullPath = (req.baseUrl ?? '') + req.path;
  for (const entry of entries) {
    if (entry.method === method && entry.regex.test(fullPath)) {
      return { ...entry.validators, routePattern: entry.pattern };
    }
  }
  return undefined;
}
