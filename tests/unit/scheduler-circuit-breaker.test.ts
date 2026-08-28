import { describe, expect, it } from 'vitest';
import { SchedulerCircuitBreaker } from '../../src/scheduler/circuit_breaker';
import { CircuitState, SchedulerCircuitConfig } from '../../src/scheduler/types';

function makeBreaker(cfg: Partial<SchedulerCircuitConfig> = {}) {
  const time = { now: 1_000_000 };
  const breaker = new SchedulerCircuitBreaker({
    failureThreshold: 3,
    windowMs: 5 * 60 * 1000,
    cooldownMs: 5 * 1000,
    now: () => time.now,
  });
  return { breaker, time };
}

describe('SchedulerCircuitBreaker', () => {
  it('starts closed and allows calls', () => {
    const { breaker } = makeBreaker();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.isAllowed()).toBe(true);
  });

  it('stays closed below the failure threshold', async () => {
    const { breaker } = makeBreaker();
    for (let i = 0; i < 2; i++) {
      breaker.record(false);
    }
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.getRecentFailures()).toBe(2);
  });

  it('trips open after failureThreshold failures in the window', async () => {
    const { breaker } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.record(false);
    expect(breaker.getState()).toBe(CircuitState.OPEN);
  });

  it('expires old failures once they leave the sliding window', async () => {
    const { breaker, time } = makeBreaker();
    breaker.record(false);
    breaker.record(false);
    time.now += 5 * 60 * 1000 + 1; // failures now older than the window
    expect(breaker.getRecentFailures()).toBe(0);
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('returns to half-open after the cooldown and admits a single probe', async () => {
    const { breaker, time } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.record(false);
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    time.now += 6 * 1000; // past the 5s cooldown
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
    expect(breaker.isAllowed()).toBe(true); // the single probe
    expect(breaker.isAllowed()).toBe(false); // no others while probing
  });

  it('closes on a successful probe', async () => {
    const { breaker, time } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.record(false);
    time.now += 6 * 1000;
    expect(breaker.isAllowed()).toBe(true);
    breaker.record(true); // probe succeeded
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.getRecentFailures()).toBe(0);
  });

  it('reopens immediately when the probe fails', async () => {
    const { breaker, time } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.record(false);
    time.now += 6 * 1000;
    expect(breaker.isAllowed()).toBe(true);
    breaker.record(false); // probe failed
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    expect(breaker.isAllowed()).toBe(false);
  });

  it('execute throws when open and succeeds when allowed', async () => {
    const { breaker, time } = makeBreaker();
    await expect(
      breaker.execute(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(
      breaker.execute(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(
      breaker.execute(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    await expect(breaker.execute(async () => 1)).rejects.toThrow('Circuit breaker is open');

    time.now += 6 * 1000;
    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('reset returns to a clean closed state', () => {
    const { breaker } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.record(false);
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    breaker.reset();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.getRecentFailures()).toBe(0);
  });
});
