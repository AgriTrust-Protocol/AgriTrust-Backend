export interface BaggageEntry {
  value: string;
  metadata?: string;
}

export class BaggageManager {
  private static readonly MAX_ENTRIES = 64;
  private static readonly MAX_VALUE_LENGTH = 512;
  private static readonly MAX_TOTAL_LENGTH = 8192;
  private static readonly PREFIX = 'agritrust.';

  private entries = new Map<string, BaggageEntry>();

  constructor(header?: string) {
    if (header) {
      this.parse(header);
    }
  }

  private parse(header: string): void {
    const pairs = header.split(',');
    for (const pair of pairs) {
      if (this.entries.size >= BaggageManager.MAX_ENTRIES) break;

      const [kv, ...metaParts] = pair.trim().split(';');
      const [key, value] = kv.split('=');

      if (key && value) {
        const trimmedKey = key.trim();
        const trimmedValue = value.trim();
        const metadata = metaParts.join(';').trim();

        if (trimmedValue.length < BaggageManager.MAX_VALUE_LENGTH) {
          this.entries.set(trimmedKey, {
            value: trimmedValue,
            metadata: metadata || undefined,
          });
        }
      }
    }
  }

  get(key: string): string | undefined {
    return this.entries.get(key)?.value;
  }

  set(key: string, value: string, metadata?: string): void {
    if (this.entries.size >= BaggageManager.MAX_ENTRIES && !this.entries.has(key)) {
      return;
    }
    if (value.length >= BaggageManager.MAX_VALUE_LENGTH) {
      return;
    }
    this.entries.set(key, { value, metadata });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  getAll(): Map<string, BaggageEntry> {
    return new Map(this.entries);
  }

  format(): string {
    const parts: string[] = [];
    let totalLength = 0;

    for (const [key, entry] of this.entries) {
      let part = `${key}=${entry.value}`;
      if (entry.metadata) {
        part += `;${entry.metadata}`;
      }

      if (totalLength + part.length + (parts.length > 0 ? 1 : 0) <= BaggageManager.MAX_TOTAL_LENGTH) {
        parts.push(part);
        totalLength += part.length + (parts.length > 1 ? 1 : 0);
      } else {
        break;
      }
    }

    return parts.join(',');
  }

  /**
   * Isolates internal headers by prefixing them with agritrust.
   */
  static isolateInternalHeader(key: string): string {
    if (key.toLowerCase().startsWith(this.PREFIX)) {
      return key.toLowerCase();
    }
    return `${this.PREFIX}${key.toLowerCase().replace(/^x-/, '')}`;
  }
}
