import { Pool, PoolClient } from 'pg';
import { BatchStatus } from './types/batchStatus';
import { isValidTransition, VALID_TRANSITIONS } from './config/statusTransitions';

/**
 * Transition validator service.
 *
 * Performs both application-level and database-level validation of batch
 * status transitions. The application-level check provides fast early
 * rejection, while the database-level `validate_transition()` function
 * provides the atomic backstop inside the UPDATE transaction.
 */
export class TransitionValidator {
  constructor(private readonly pool: Pool) {}

  /**
   * Validates that a transition is legal at the application level.
   * Returns the current status, or throws if the transition is invalid.
   */
  validateStatusTransition(
    currentStatus: BatchStatus,
    targetStatus: BatchStatus,
  ): void {
    // Idempotency: already at target = success (handled by caller).
    if (currentStatus === targetStatus) {
      return;
    }

    if (!isValidTransition(currentStatus, targetStatus)) {
      throw new InvalidTransitionError(currentStatus, targetStatus);
    }
  }

  /**
   * Calls the PostgreSQL validate_transition() function for atomic
   * server-side validation within the same transaction as the UPDATE.
   * Must be called inside a transaction with a client.
   */
  async validateInTransaction(
    client: PoolClient,
    currentStatus: BatchStatus,
    targetStatus: BatchStatus,
  ): Promise<void> {
    const res = await client.query(
      'SELECT validate_transition($1, $2) AS valid',
      [currentStatus, targetStatus],
    );

    if (!res.rows[0]?.valid) {
      throw new InvalidTransitionError(currentStatus, targetStatus);
    }
  }
}

/** Error thrown when a transition is not in the valid DAG. */
export class InvalidTransitionError extends Error {
  public readonly currentStatus: BatchStatus;
  public readonly targetStatus: BatchStatus;

  constructor(current: BatchStatus, target: BatchStatus) {
    super(
      `Invalid transition: ${current} → ${target}. ` +
      `Valid forward step is: ${[...getValidTargets(current)].join(' → ')}`,
    );
    this.name = 'InvalidTransitionError';
    this.currentStatus = current;
    this.targetStatus = target;
  }
}

function getValidTargets(status: BatchStatus): BatchStatus[] {
  return Array.from(VALID_TRANSITIONS[status] ?? []);
}
