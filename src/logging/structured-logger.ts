import { context, trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type LogAttributeValue = string | number | boolean | null | undefined;
export type LogAttributes = Record<string, LogAttributeValue | LogAttributeValue[]>;

export interface StructuredLoggerOptions {
  serviceName?: string;
  serviceVersion?: string;
  environment?: string;
  sink?: (line: string) => void;
  clock?: () => Date;
  redactKeys?: string[];
}

const DEFAULT_REDACT_KEYS = [
  'authorization',
  'cookie',
  'password',
  'secret',
  'token',
  'api_key',
  'apikey',
  'private_key',
  'key_encryption_master_key',
];

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

export class StructuredLogger {
  private readonly serviceName: string;
  private readonly serviceVersion: string;
  private readonly environment: string;
  private readonly sink: (line: string) => void;
  private readonly clock: () => Date;
  private readonly redactKeys: string[];
  private readonly otelLogger = logs.getLogger('agritrust.structured-logger');

  constructor(options: StructuredLoggerOptions = {}) {
    this.serviceName = options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'agritrust-backend';
    this.serviceVersion = options.serviceVersion ?? process.env.npm_package_version ?? 'unknown';
    this.environment = options.environment ?? process.env.NODE_ENV ?? 'development';
    this.sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
    this.clock = options.clock ?? (() => new Date());
    this.redactKeys = (options.redactKeys ?? DEFAULT_REDACT_KEYS).map((key) => key.toLowerCase());
  }

  debug(message: string, attributes: LogAttributes = {}) {
    this.log('debug', message, attributes);
  }

  info(message: string, attributes: LogAttributes = {}) {
    this.log('info', message, attributes);
  }

  warn(message: string, attributes: LogAttributes = {}) {
    this.log('warn', message, attributes);
  }

  error(message: string, error?: unknown, attributes: LogAttributes = {}) {
    this.log('error', message, this.withErrorAttributes(error, attributes));
  }

  fatal(message: string, error?: unknown, attributes: LogAttributes = {}) {
    this.log('fatal', message, this.withErrorAttributes(error, attributes));
  }

  child(defaultAttributes: LogAttributes): StructuredLogger {
    const parent = this;
    return new (class extends StructuredLogger {
      log(level: LogLevel, message: string, attributes: LogAttributes = {}) {
        parent.log(level, message, { ...defaultAttributes, ...attributes });
      }
    })();
  }

  log(level: LogLevel, message: string, attributes: LogAttributes = {}) {
    const spanContext = trace.getSpanContext(context.active()) ?? trace.getSpan(context.active())?.spanContext();
    const sanitizedAttributes = this.redact(attributes);
    const record = {
      timestamp: this.clock().toISOString(),
      severity_text: level.toUpperCase(),
      severity_number: SEVERITY[level],
      body: message,
      trace_id: spanContext?.traceId,
      span_id: spanContext?.spanId,
      trace_flags: spanContext?.traceFlags,
      resource: {
        [ATTR_SERVICE_NAME]: this.serviceName,
        [ATTR_SERVICE_VERSION]: this.serviceVersion,
        'deployment.environment.name': this.environment,
      },
      attributes: sanitizedAttributes,
    };

    this.otelLogger.emit({
      severityNumber: SEVERITY[level],
      severityText: record.severity_text,
      body: message,
      attributes: sanitizedAttributes,
    });

    this.sink(JSON.stringify(record));
  }

  private withErrorAttributes(error: unknown, attributes: LogAttributes): LogAttributes {
    if (!error) return attributes;
    if (error instanceof Error) {
      return {
        ...attributes,
        [ATTR_EXCEPTION_TYPE]: error.name,
        [ATTR_EXCEPTION_MESSAGE]: error.message,
        [ATTR_EXCEPTION_STACKTRACE]: error.stack,
      };
    }
    return { ...attributes, [ATTR_EXCEPTION_MESSAGE]: String(error) };
  }

  private redact(attributes: LogAttributes): LogAttributes {
    const sanitized: LogAttributes = {};
    for (const [key, value] of Object.entries(attributes)) {
      sanitized[key] = this.shouldRedact(key) ? '[REDACTED]' : value;
    }
    return sanitized;
  }

  private shouldRedact(key: string): boolean {
    const normalized = key.toLowerCase();
    return this.redactKeys.some((redactKey) => normalized.includes(redactKey));
  }
}

export const logger = new StructuredLogger();
