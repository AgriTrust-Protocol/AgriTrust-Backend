export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  failureWindowMs?: number;
  openCooldownMs?: number;
  now?: () => number;
}

export class CircuitOpenError extends Error {
  constructor(operation: string) {
    super(`Circuit breaker is open for operation ${operation}`);
    this.name = 'CircuitOpenError';
  }
}

interface CircuitState {
  state: CircuitBreakerState;
  failures: number[];
  openedAt?: number;
  halfOpenProbeInFlight: boolean;
}

export class CircuitBreakerRegistry {
  private readonly circuits = new Map<string, CircuitState>();
  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly openCooldownMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.failureWindowMs = options.failureWindowMs ?? 5 * 60_000;
    this.openCooldownMs = options.openCooldownMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  canExecute(operation: string): boolean {
    const circuit = this.get(operation);
    if (circuit.state === 'closed') return true;
    if (circuit.state === 'half-open') {
      if (circuit.halfOpenProbeInFlight) return false;
      circuit.halfOpenProbeInFlight = true;
      return true;
    }

    if ((this.now() - (circuit.openedAt ?? 0)) >= this.openCooldownMs) {
      circuit.state = 'half-open';
      circuit.halfOpenProbeInFlight = true;
      return true;
    }
    return false;
  }

  assertCanExecute(operation: string): void {
    if (!this.canExecute(operation)) throw new CircuitOpenError(operation);
  }

  recordSuccess(operation: string): void {
    this.circuits.set(operation, { state: 'closed', failures: [], halfOpenProbeInFlight: false });
  }

  recordFailure(operation: string): CircuitBreakerState {
    const circuit = this.get(operation);
    const now = this.now();
    circuit.halfOpenProbeInFlight = false;
    circuit.failures = [...circuit.failures, now].filter((ts) => now - ts <= this.failureWindowMs);

    if (circuit.state === 'half-open' || circuit.failures.length >= this.failureThreshold) {
      circuit.state = 'open';
      circuit.openedAt = now;
    }
    return circuit.state;
  }

  getState(operation: string): CircuitBreakerState {
    return this.get(operation).state;
  }

  snapshot(): Record<string, CircuitBreakerState> {
    return Object.fromEntries([...this.circuits.entries()].map(([op, circuit]) => [op, circuit.state]));
  }

  private get(operation: string): CircuitState {
    let circuit = this.circuits.get(operation);
    if (!circuit) {
      circuit = { state: 'closed', failures: [], halfOpenProbeInFlight: false };
      this.circuits.set(operation, circuit);
    }
    return circuit;
  }
}
