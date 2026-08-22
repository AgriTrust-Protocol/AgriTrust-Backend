/**
 * Batch Processor for Supply Log Provenance
 *
 * Processes supply log batches submitted by farmers, verifying ZK range proofs
 * against certification dimensions before accepting the batch into the system.
 *
 * The verifyZKProofs step checks that each certification dimension in the batch
 * has a valid zero-knowledge range proof bound to the submitting farmer.
 * Batches with missing or invalid proofs are rejected.
 */

import type {
  SupplyLogBatch,
  BatchProof,
  RangeProof,
  CertificationDimension,
} from '../../crypto/types';
import { ZKError, DIMENSION_IDS } from '../../crypto/types';
import { verifyRangeProof, generateRangeProof } from '../../crypto/zk_provenance';
import { bytesEqual } from '../../crypto/commitment_scheme';

// ─── Configuration ───────────────────────────────────────────────────────────

/** Required certification dimensions that every batch must prove. */
const REQUIRED_DIMENSIONS: CertificationDimension[] = [
  'organic_compost_used',
  'pesticide_free_days',
  'nitrate_level',
];

/** Verification timeout per batch (must complete under 500ms). */
const VERIFICATION_TIMEOUT_MS = 500;

/** Ranges for each certification dimension. */
const DIMENSION_RANGES: Record<CertificationDimension, { min: number; max: number }> = {
  organic_compost_used: { min: 0, max: 1 }, // boolean: 0=no, 1=yes
  pesticide_free_days: { min: 0, max: 365 }, // days in a year
  nitrate_level: { min: 0, max: 500 }, // ppm
  soil_ph: { min: 0, max: 14 }, // pH scale
  water_usage: { min: 0, max: 100000 }, // liters
  carbon_footprint: { min: 0, max: 10000 }, // kg CO2 equivalent
};

// ─── Verification Result ─────────────────────────────────────────────────────

export interface ZKVerificationResult {
  /** Whether all proofs passed verification. */
  valid: boolean;
  /** Per-dimension results. */
  dimensions: Record<string, { valid: boolean; error?: string }>;
  /** Total verification time in milliseconds. */
  verificationTimeMs: number;
}

// ─── Batch Processor ─────────────────────────────────────────────────────────

/**
 * Processes a supply log batch, including ZK proof verification.
 *
 * Pipeline:
 *   1. Validate batch metadata
 *   2. Verify ZK proofs for all required dimensions
 *   3. If valid, accept the batch (in production, this would persist to DB)
 *   4. If invalid, reject with detailed dimension-level errors
 *
 * @param batch - The supply log batch to process.
 * @param farmerPublicKey - The farmer's public key (32 bytes) for proof verification.
 * @returns Verification result with per-dimension status.
 */
export function processBatch(
  batch: SupplyLogBatch,
  farmerPublicKey: Uint8Array,
): ZKVerificationResult {
  const startTime = Date.now();

  // Step 1: Validate batch has proofs
  if (!batch.proofs) {
    return {
      valid: false,
      dimensions: Object.fromEntries(
        REQUIRED_DIMENSIONS.map((d) => [d, { valid: false, error: 'Missing proofs' }]),
      ),
      verificationTimeMs: Date.now() - startTime,
    };
  }

  // Step 2: Verify farmer binding (prevent cross-farmer proof substitution)
  if (!bytesEqual(batch.proofs.farmerPublicKey, farmerPublicKey)) {
    return {
      valid: false,
      dimensions: Object.fromEntries(
        REQUIRED_DIMENSIONS.map((d) => [
          d,
          {
            valid: false,
            error: 'Farmer public key mismatch',
          },
        ]),
      ),
      verificationTimeMs: Date.now() - startTime,
    };
  }

  // Step 3: Verify ZK proofs for each required dimension
  const dimensionResults: Record<string, { valid: boolean; error?: string }> = {};
  let allValid = true;

  for (const dimension of REQUIRED_DIMENSIONS) {
    const startDim = Date.now();

    try {
      const proof = findProofForDimension(batch.proofs.proofs, dimension);
      if (!proof) {
        dimensionResults[dimension] = {
          valid: false,
          error: `Missing proof for dimension: ${dimension}`,
        };
        allValid = false;
        continue;
      }

      const range = DIMENSION_RANGES[dimension];
      const valid = verifyRangeProof(proof, farmerPublicKey, range.min, range.max);

      dimensionResults[dimension] = {
        valid,
        error: valid ? undefined : 'Range proof verification failed',
      };

      if (!valid) allValid = false;
    } catch (err) {
      dimensionResults[dimension] = {
        valid: false,
        error: err instanceof Error ? err.message : 'Unknown verification error',
      };
      allValid = false;
    }

    // Step 4: Check per-dimension timeout
    const dimTime = Date.now() - startDim;
    if (dimTime > 100) {
      console.warn(`ZK verification for ${dimension} took ${dimTime}ms (threshold: 100ms)`);
    }
  }

  const totalTime = Date.now() - startTime;

  // Step 5: Check total verification timeout
  if (totalTime > VERIFICATION_TIMEOUT_MS) {
    console.warn(
      `Batch ZK verification took ${totalTime}ms (threshold: ${VERIFICATION_TIMEOUT_MS}ms)`,
    );
  }

  return {
    valid: allValid,
    dimensions: dimensionResults,
    verificationTimeMs: totalTime,
  };
}

/**
 * Finds the RangeProof for a specific certification dimension in a proofs array.
 */
function findProofForDimension(
  proofs: RangeProof[],
  dimensionName: string,
): RangeProof | undefined {
  const targetId = DIMENSION_IDS[dimensionName];
  if (!targetId) return undefined;

  return proofs.find((p) => bytesEqual(p.dimensionId, targetId));
}

/**
 * Generates a complete BatchProof for a set of dimension values.
 * This is used by farmers to create proofs before submitting a batch.
 *
 * @param farmerSeed - 32-byte farmer-specific seed.
 * @param farmerPublicKey - 32-byte farmer public key.
 * @param values - Map of dimension name to value.
 * @returns A BatchProof ready to attach to a supply log batch.
 */
export function generateBatchProof(
  farmerSeed: Uint8Array,
  farmerPublicKey: Uint8Array,
  values: Partial<Record<CertificationDimension, number>>,
): BatchProof {
  const proofs: RangeProof[] = [];
  for (const [dimension, value] of Object.entries(values) as [CertificationDimension, number][]) {
    const range = DIMENSION_RANGES[dimension];
    if (!range) continue;

    try {
      const proof = generateRangeProof(value, range.min, range.max, farmerSeed, dimension);
      proofs.push(proof);
    } catch (err) {
      throw new ZKError(
        `Failed to generate proof for ${dimension}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    farmerPublicKey,
    proofs,
    timestamp: Date.now(),
  };
}

export { REQUIRED_DIMENSIONS, DIMENSION_RANGES };
