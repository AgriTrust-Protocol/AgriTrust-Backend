import { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import {
  BatchStatus,
  BatchRow,
  TransitionRequest,
  TransitionResult,
  MAX_RETRIES,
  BatchTransitionJob,
} from './types/batchStatus';
import { TransitionValidator, InvalidTransitionError } from './transitionValidator';
import { AuditLogger } from './auditLogger';
import { WorkflowEngine } from './services/workflowEngine';

/**
 * Batch Status Workflow — transitionBatch()
 *
 * Transitions a batch through the lifecycle: REGISTERED → INSPECTED →
 * CERTIFIED → SHIPPED → DELIVERED using optimistic locking with
 * queue-based retry, atomic DB-level validation, and at-most-once
 * idempotency.
 *
 * # Race-condition fix (issue #31):
 * The retry path now re-reads the current state and re-validates the
 * transition from the ACTUAL current state, not the stale one. Combined
 * with the processed_transitions table (at-most-once guard) and the
 * idempotency key on audit events, each transition fires exactly once
 * even under concurrent load.
 */
export class BatchStatusWorkflow {
  private readonly validator: TransitionValidator;
  private readonly auditor: AuditLogger;
  readonly engine: WorkflowEngine;

  constructor(private readonly pool: Pool) {
    this.validator = new TransitionValidator(pool);
    this.auditor = new AuditLogger(pool);
    this.engine = new WorkflowEngine();

    // Register the retry handler.
    this.engine.onRetry(this.handleRetry.bind(this));
  }

  /**
   * Attempts to transition a batch to the target status.
   *
   * @returns TransitionResult with code:
   *   - 200: transition applied successfully
   *   - 202: already in target state or transition already processed
   *   - 409: optimistic-lock conflict (enqueued for retry)
   *   - 422: invalid transition
   */
  async transitionBatch(req: TransitionRequest): Promise<TransitionResult> {
    const idempotencyKey = uuidv7();

    try {
      return await this.attemptTransition(req, idempotencyKey, 1);
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return {
          success: false,
          batchId: req.batchId,
          previousStatus: err.currentStatus,
          currentStatus: err.currentStatus,
          idempotencyKey,
          code: 422,
          reason: err.message,
        };
      }
      throw err;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Single transition attempt. Reads current state, validates, updates.
   * On version conflict, enqueues a retry via the workflow engine.
   */
  private async attemptTransition(
    req: TransitionRequest,
    idempotencyKey: string,
    attempt: number,
  ): Promise<TransitionResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Step 1: Read current batch state.
      const current = await this.readBatch(client, req.batchId);
      if (!current) {
        await client.query('ROLLBACK');
        return {
          success: false,
          batchId: req.batchId,
          previousStatus: null,
          currentStatus: null,
          idempotencyKey,
          code: 422,
          reason: `Batch ${req.batchId} not found`,
        };
      }

      // Step 2: Idempotency — if already at target, return 202.
      if (current.status === req.targetStatus) {
        await client.query('ROLLBACK');
        return {
          success: true,
          batchId: req.batchId,
          previousStatus: current.status,
          currentStatus: current.status,
          idempotencyKey,
          code: 202,
          reason: 'Batch already in target status',
        };
      }

      // Step 3: Validate transition from the ACTUAL current state.
      //         This is the key fix: on retry, we validate against the
      //         freshly-read state, not the stale one from a prior attempt.
      this.validator.validateStatusTransition(current.status, req.targetStatus);

      // Step 4: Atomic DB-level validation using the server-side function.
      await this.validator.validateInTransaction(client, current.status, req.targetStatus);

      // Step 5: At-most-once guard via processed_transitions table.
      //         If this exact (batch_id, status_before, status_after)
      //         transition was already processed, return 202.
      const deduped = await this.insertProcessedTransition(
        client,
        req.batchId,
        idempotencyKey,
        current.status,
        req.targetStatus,
      );
      if (!deduped) {
        await client.query('COMMIT');
        return {
          success: true,
          batchId: req.batchId,
          previousStatus: current.status,
          currentStatus: req.targetStatus,
          idempotencyKey,
          code: 202,
          reason: 'Transition already processed',
        };
      }

      // Step 6: Optimistic update with version check.
      const updateResult = await client.query(
        `UPDATE batches
            SET status = $1, version = version + 1, updated_at = NOW()
          WHERE id = $2 AND version = $3
          RETURNING status, version`,
        [req.targetStatus, req.batchId, current.version],
      );

      if (updateResult.rowCount === 0) {
        // Version conflict — another writer won the race.
        await client.query('ROLLBACK');

        if (attempt <= MAX_RETRIES) {
          // Enqueue a delayed retry. The worker will re-read current state
          // and validate from the ACTUAL state, fixing the stale-state bug.
          this.engine.enqueueRetry({
            batchId: req.batchId,
            targetStatus: req.targetStatus,
            idempotencyKey,
            attempt,
            maxRetries: MAX_RETRIES,
            createdAt: Date.now(),
          });
        }

        return {
          success: false,
          batchId: req.batchId,
          previousStatus: current.status,
          currentStatus: current.status,
          idempotencyKey,
          code: 409,
          reason:
            attempt <= MAX_RETRIES
              ? `Version conflict — retry ${attempt}/${MAX_RETRIES} enqueued`
              : `Version conflict — max retries (${MAX_RETRIES}) exhausted`,
        };
      }

      await client.query('COMMIT');

      // Step 7: Record audit event (outside transaction — fires once).
      await this.auditor.logTransition(
        req.batchId,
        `transition`,
        current.status,
        req.targetStatus,
        idempotencyKey,
      );

      return {
        success: true,
        batchId: req.batchId,
        previousStatus: current.status,
        currentStatus: req.targetStatus,
        idempotencyKey,
        code: 200,
      };
    } catch (err) {
      await this.safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Handles a retry job from the workflow engine.
   * Re-reads current state and validates from the ACTUAL state.
   */
  private async handleRetry(job: BatchTransitionJob): Promise<boolean> {
    const result = await this.attemptTransition(
      { batchId: job.batchId, targetStatus: job.targetStatus },
      job.idempotencyKey,
      job.attempt,
    );

    return result.code === 200 || result.code === 202;
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async readBatch(client: PoolClient, batchId: string): Promise<BatchRow | null> {
    const res = await client.query(
      `SELECT id, status, version, created_at, updated_at
         FROM batches WHERE id = $1`,
      [batchId],
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      status: row.status as BatchStatus,
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Inserts a row into processed_transitions as the at-most-once guard.
   * Returns true if inserted, false if already exists (duplicate).
   */
  private async insertProcessedTransition(
    client: PoolClient,
    batchId: string,
    transitionId: string,
    statusBefore: BatchStatus,
    statusAfter: BatchStatus,
  ): Promise<boolean> {
    const res = await client.query(
      `INSERT INTO processed_transitions
         (batch_id, transition_id, status_before, status_after)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (batch_id, status_before, status_after) DO NOTHING
       RETURNING id`,
      [batchId, transitionId, statusBefore, statusAfter],
    );
    return (res.rowCount ?? 0) > 0;
  }

  private async safeRollback(client: PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be aborted; ignore */
    }
  }
}
