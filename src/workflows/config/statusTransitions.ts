import { BatchStatus } from '../types/batchStatus';

/**
 * State transition DAG: REGISTERED → INSPECTED → CERTIFIED → SHIPPED → DELIVERED.
 *
 * Maps each status to the set of valid target statuses it can transition to.
 * Used by the transition validator and the PostgreSQL validate_transition function.
 */
export const VALID_TRANSITIONS: Readonly<Record<BatchStatus, ReadonlySet<BatchStatus>>> = {
  REGISTERED: new Set<BatchStatus>(['INSPECTED']),
  INSPECTED: new Set<BatchStatus>(['CERTIFIED']),
  CERTIFIED: new Set<BatchStatus>(['SHIPPED']),
  SHIPPED: new Set<BatchStatus>(['DELIVERED']),
  DELIVERED: new Set<BatchStatus>([]),
} as const;

/**
 * Checks whether a transition from `current` to `target` is a legal forward
 * step in the batch lifecycle DAG.
 */
export function isValidTransition(current: BatchStatus, target: BatchStatus): boolean {
  const validTargets = VALID_TRANSITIONS[current];
  if (!validTargets) return false;
  return validTargets.has(target);
}
