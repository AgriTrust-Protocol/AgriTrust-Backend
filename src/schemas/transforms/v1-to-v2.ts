import { TransformFunction } from '../../config/api-versions';

/**
 * Transforms v1 request body to v2 format.
 * v1 uses 'metadata', v2 uses 'context'.
 */
export const v1ToV2RequestTransform: TransformFunction = (data: any) => {
  if (data && typeof data === 'object' && 'metadata' in data) {
    const { metadata, ...rest } = data;
    return {
      ...rest,
      context: metadata,
    };
  }
  return data;
};

/**
 * Transforms v2 response body to v1 format.
 * If there's a need to map fields back for v1 clients.
 */
export const v2ToV1ResponseTransform: TransformFunction = (data: any) => {
  // In this specific case, if the response includes something that changed, we'd map it back.
  // For 'certifyBatch', the response is { message, certificate_id }, which hasn't changed.
  // But let's assume we might add 'context' in response in v2, and v1 expects 'metadata'.
  if (data && typeof data === 'object' && 'context' in data) {
    const { context, ...rest } = data;
    return {
      ...rest,
      metadata: context,
    };
  }
  return data;
};
