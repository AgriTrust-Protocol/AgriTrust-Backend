export interface SecretAccessAuditEvent {
  caller: string;
  secretPath: string;
  timestamp: string;
}

export class AuditLogger {
  constructor(private readonly vaultAuditPath = process.env.VAULT_AUDIT_LOG_PATH) {}

  async logAccess(secretPath: string, caller = AuditLogger.detectCaller()): Promise<void> {
    const event: SecretAccessAuditEvent = {
      caller,
      secretPath,
      timestamp: new Date().toISOString(),
    };

    if (this.vaultAuditPath) {
      console.info(`[VaultAudit:${this.vaultAuditPath}]`, JSON.stringify(event));
    } else {
      console.info('[VaultAudit]', JSON.stringify(event));
    }
  }

  static detectCaller(): string {
    const stack = new Error().stack?.split('\n').slice(2) ?? [];
    return stack.find((line) => !line.includes('audit-logger'))?.trim() ?? 'unknown';
  }
}
