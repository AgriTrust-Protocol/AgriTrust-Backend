import { CircuitState, SchedulerCircuitConfig } from './types';

/**
 * Per-operation circuit breaker from issue #168.
 *
 * Tracks failures in a sliding time window. When `failureThreshold` failures
 * occur within `windowMs`, the breaker trips to `open` and refuses calls for
 * `cooldownMs`. After the cooldown elapses a single probe call is allowed
 * (`half_open`); a successful probe resets the breaker to `closed`, a failed
 * probe trips it straight back `open`.
 *
 * Example load: the irrigation-pump API returns 5xx three times in five
 * minutes → the pump breaker trips, so subsequent irrigation jobs short-circuit
 * instead of hammering the failing dependency.
 */
export class SchedulerCircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureTimestamps: number[] = [];
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(config: SchedulerCircuitConfig) {
    this.failureThreshold = config.failureThreshold;
    this.windowMs = config.windowMs;
    this.cooldownMs = config.cooldownMs;
    this.now = config.now ?? Date.now;
  }

  getState(): CircuitState {
    this.pruneFailures();
    if (this.state === CircuitState.OPEN && this.now() - this.openedAt > this.cooldownMs) {
      // Persist the state so `record()` observes the half-open probe phase.
      this.state = CircuitState.HALF_OPEN;
      this.halfOpenProbeTaken = false;
    }
    return this.state;
  }

  /**
   * True if a call may proceed. In `half_open`, only a single probe is
   * admitted; concurrent callers are short-circuited until the probe settles.
   */
  isAllowed(): boolean {
    const state = this.getState();
    if (state === CircuitState.CLOSED) return true;
    if (state === CircuitState.HALF_OPEN) {
      if (this.halfOpenProbeTaken) return false;
      this.halfOpenProbeTaken = true;
      return true;
    }
    return false;
  }

  private halfOpenProbeTaken = false;

  /** Record a completed call. `ok` is false when the call failed. */
  record(ok: boolean): void {
    this.pruneFailures();

    if (this.state === CircuitState.HALF_OPEN) {
      if (ok) {
        this.state = CircuitState.CLOSED;
        this.failureTimestamps = [];
        this.halfOpenProbeTaken = false;
      } else {
        this.state = CircuitState.OPEN;
        this.openedAt = this.now();
        this.failureTimestamps.push(this.now());
        this.halfOpenProbeTaken = false;
      }
      return;
    }

    if (!ok) {
      const now = this.now();
      this.failureTimestamps.push(now);
      if (this.failureTimestamps.length >= this.failureThreshold) {
        this.state = CircuitState.OPEN;
        this.openedAt = now;
      }
    }
    // On success while closed we simply age the window; a lone success does not
    // clear accumulated failures, which matches "3 failures in 5 minutes".
  }

  /** Execute `fn` guarded by the breaker. Throws immediately when open. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.isAllowed()) {
      throw new Error('Circuit breaker is open');
    }
    try {
      const result = await fn();
      this.record(true);
      return result;
    } catch (err) {
      this.record(false);
      throw err;
    }
  }

  /** Rewind to a clean slate (tests / operator resets). */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureTimestamps = [];
    this.openedAt = 0;
    this.halfOpenProbeTaken = false;
  }

  /** Number of failures within the current sliding window. */
  getRecentFailures(): number {
    this.pruneFailures();
    return this.failureTimestamps.length;
  }

  private pruneFailures(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.failureTimestamps.length > 0 && this.failureTimestamps[0] < cutoff) {
      this.failureTimestamps.shift();
    }
  }
}
