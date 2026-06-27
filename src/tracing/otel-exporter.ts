import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import * as grpc from '@grpc/grpc-js';
import { tracingConfig } from '../config/tracing';

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
    }),
  });

  sdk.start()
    .then(() => console.log(`Tracing initialized for ${serviceName}`))
    .catch((error) => console.error('Error initializing tracing', error));

  process.on('SIGTERM', () => {
    sdk.shutdown()
      .then(() => console.log('Tracing terminated'))
      .catch((error) => console.error('Error terminating tracing', error))
      .finally(() => process.exit(0));
  });

  return sdk;
}
