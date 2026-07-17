import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { context, trace, TraceFlags, ROOT_CONTEXT } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ATTR_EXCEPTION_MESSAGE, ATTR_EXCEPTION_TYPE } from '@opentelemetry/semantic-conventions';
import { StructuredLogger } from '../../src/logging/structured-logger';

describe('StructuredLogger', () => {
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
  });

  afterAll(() => {
    context.disable();
  });

  it('emits JSON logs with OpenTelemetry severity and service resource attributes', () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({
      serviceName: 'agritrust-test',
      serviceVersion: '1.2.3',
      environment: 'test',
      sink: (line) => lines.push(line),
      clock: () => new Date('2026-07-17T00:00:00.000Z'),
    });

    logger.info('certificate.minted', { 'agritrust.batch_id': 'batch-1' });

    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      timestamp: '2026-07-17T00:00:00.000Z',
      severity_text: 'INFO',
      severity_number: 9,
      body: 'certificate.minted',
      resource: {
        'service.name': 'agritrust-test',
        'service.version': '1.2.3',
        'deployment.environment.name': 'test',
      },
      attributes: {
        'agritrust.batch_id': 'batch-1',
      },
    });
  });

  it('redacts sensitive attributes and formats exception semantic attributes', () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({ sink: (line) => lines.push(line) });

    logger.error('vault.read.failed', new TypeError('boom'), {
      authorization: 'Bearer secret',
      'db.password': 'secret',
      'agritrust.tenant_id': 'tenant-1',
    });

    const record = JSON.parse(lines[0]);
    expect(record.attributes.authorization).toBe('[REDACTED]');
    expect(record.attributes['db.password']).toBe('[REDACTED]');
    expect(record.attributes['agritrust.tenant_id']).toBe('tenant-1');
    expect(record.attributes[ATTR_EXCEPTION_TYPE]).toBe('TypeError');
    expect(record.attributes[ATTR_EXCEPTION_MESSAGE]).toBe('boom');
  });

  it('links active OpenTelemetry trace context into each structured log', () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({ sink: (line) => lines.push(line) });
    const spanContext = {
      traceId: '1234567890abcdef1234567890abcdef',
      spanId: '1234567890abcdef',
      traceFlags: TraceFlags.SAMPLED,
    };

    const ctx = trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext));
    context.with(ctx, () => {
      logger.warn('rate_limit.near_capacity');
    });

    const record = JSON.parse(lines[0]);
    expect(record.trace_id).toBe(spanContext.traceId);
    expect(record.span_id).toBe(spanContext.spanId);
    expect(record.trace_flags).toBe(TraceFlags.SAMPLED);
  });
});
