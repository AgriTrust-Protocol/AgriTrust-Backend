import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import * as grpc from '@grpc/grpc-js';
import { tracingConfig } from '../config/tracing';
import { logger } from '../logging/structured-logger';

export function setupTracing(serviceName: string) {
  const exporter = new OTLPTraceExporter({
    url: tracingConfig.collectorEndpoint,
    credentials: grpc.credentials.createInsecure(),
  });

  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    }),
    spanProcessor: new BatchSpanProcessor(exporter, {
      scheduledDelayMillis: tracingConfig.batchIntervalMs,
    }) as never,
    // Auto-instrument every PostgreSQL query so each DB call becomes a child
    // span of the active request span (issue #177).
    instrumentations: [new PgInstrumentation()],
  });

  try {
    sdk.start();
    logger.info('otel.tracing.initialized', { 'service.name': serviceName });
  } catch (error) {
    logger.error('otel.tracing.initialization_failed', error);
  }

  process.on('SIGTERM', () => {
    sdk
      .shutdown()
      .then(() => logger.info('otel.tracing.terminated'))
      .catch((error: unknown) => logger.error('otel.tracing.termination_failed', error))
      .finally(() => process.exit(0));
  });

  return sdk;
}
