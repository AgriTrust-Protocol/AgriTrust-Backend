export const tracingConfig = {
  samplingProbability: parseFloat(process.env.TRACING_SAMPLING_PROBABILITY || '0.8'),
  collectorEndpoint: process.env.OTEL_COLLECTOR_ENDPOINT || 'localhost:4317',
  batchIntervalMs: parseInt(process.env.OTEL_BATCH_INTERVAL_MS || '5000', 10),
};
