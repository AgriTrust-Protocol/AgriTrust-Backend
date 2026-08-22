import * as crypto from 'crypto';

export interface TraceParent {
  version: string;
  traceId: string;
  parentId: string;
  traceFlags: string;
}

export class TraceContext {
  private static readonly TRACEPARENT_REGEX =
    /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

  static generateTraceId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  static generateSpanId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  /**
   * Maps a cargo edge scanner's `X-Request-ID` to a valid W3C trace-id (32
   * lowercase hex, non-zero). If the id is already a 32-hex value it is used
   * directly; otherwise it is hashed (sha256, first 16 bytes) so the same
   * request id always resolves to the same trace-id — letting operators
   * correlate a scanner request with its server-side trace.
   */
  static traceIdFromRequestId(requestId: string): string {
    const normalized = requestId.trim().toLowerCase();
    if (/^[0-9a-f]{32}$/.test(normalized) && normalized !== '00000000000000000000000000000000') {
      return normalized;
    }
    // sha256 of a non-empty string is never all-zero, so this is always valid.
    return crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 32);
  }

  static parseTraceParent(header: string): TraceParent | null {
    const match = header.match(this.TRACEPARENT_REGEX);
    if (!match) return null;

    const [, version, traceId, parentId, traceFlags] = match;

    // Version 00 is supported, and it must have the correct lengths (already checked by regex)
    // and must not be all zeros.
    if (traceId === '00000000000000000000000000000000') return null;
    if (parentId === '0000000000000000') return null;

    return { version, traceId, parentId, traceFlags };
  }

  static formatTraceParent(traceParent: TraceParent): string {
    return `${traceParent.version}-${traceParent.traceId}-${traceParent.parentId}-${traceParent.traceFlags}`;
  }

  static parseTraceState(header: string): Map<string, string> {
    const traceState = new Map<string, string>();
    if (!header) return traceState;

    const entries = header.split(',');
    for (const entry of entries) {
      const parts = entry.trim().split('=');
      if (parts.length === 2) {
        const key = parts[0].trim();
        const value = parts[1].trim();
        if (traceState.size < 32) {
          traceState.set(key, value);
        }
      }
    }
    return traceState;
  }

  static formatTraceState(traceState: Map<string, string>): string {
    const entries: string[] = [];
    for (const [key, value] of traceState.entries()) {
      entries.push(`${key}=${value}`);
    }
    const result = entries.join(',');
    return result.length < 512 ? result : result.substring(0, result.lastIndexOf(',', 512));
  }
}
