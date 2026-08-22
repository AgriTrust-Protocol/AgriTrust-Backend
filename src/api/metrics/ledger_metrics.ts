/**
 * AgriTrust Backend – Ledger Confirmation Lag Metrics
 *
 * Exposes a gauge `ledger_confirmation_lag_seconds` that records the delta
 * between the latest confirmed ledger timestamp and NOW().
 *
 * Updated:
 *   - On every ledger close event via recordLedgerClose()
 *   - On each metrics collection interval (fallback staleness check)
 *
 * The gauge is useful for alerting when the confirmation lag exceeds
 * acceptable thresholds (e.g. > 30 s indicates a network or node issue).
 */

import { Gauge } from 'prom-client';
import { metricsRegistry } from './registry';

// ─── Prometheus Gauge ───────────────────────────────────────────────────────

export const ledgerConfirmationLagGauge = new Gauge({
  name: 'ledger_confirmation_lag_seconds',
  help: 'Seconds elapsed since the last confirmed ledger close timestamp',
  registers: [metricsRegistry],
});

export const ledgerSequenceGauge = new Gauge({
  name: 'ledger_latest_sequence',
  help: 'Latest confirmed ledger sequence number',
  registers: [metricsRegistry],
});

// ─── Internal State ─────────────────────────────────────────────────────────

let lastConfirmedAt: Date | null = null;
let lastSequence = 0;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Record a new ledger close event.
 * Call this each time a ledger close is confirmed by the network.
 *
 * @param sequence  The ledger sequence number
 * @param closedAt  The timestamp when the ledger was closed
 */
export function recordLedgerClose(sequence: number, closedAt: Date): void {
  lastConfirmedAt = closedAt;
  lastSequence = sequence;

  const lagSeconds = (Date.now() - closedAt.getTime()) / 1000;
  ledgerConfirmationLagGauge.set(Math.max(0, lagSeconds));
  ledgerSequenceGauge.set(sequence);
}

/**
 * Update the lag gauge based on the last known close time.
 * Called periodically during metric collection to keep the gauge
 * fresh even without new ledger events.
 */
export function collectLedgerMetrics(): void {
  if (lastConfirmedAt) {
    const lagSeconds = (Date.now() - lastConfirmedAt.getTime()) / 1000;
    ledgerConfirmationLagGauge.set(Math.max(0, lagSeconds));
  } else {
    // No ledger data yet — report 0 (unknown)
    ledgerConfirmationLagGauge.set(0);
  }
}

/**
 * Reset ledger metrics state (for testing).
 */
export function resetLedgerMetrics(): void {
  lastConfirmedAt = null;
  lastSequence = 0;
  ledgerConfirmationLagGauge.set(0);
  ledgerSequenceGauge.set(0);
}
