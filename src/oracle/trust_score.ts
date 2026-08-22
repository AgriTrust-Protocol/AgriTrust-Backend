export const DEFAULT_TRUST_SCORE = 1;
export const MIN_TRUST_SCORE = 0.05;
export const MAX_TRUST_SCORE = 1;
export const TRUST_DECAY = 0.9;
export const ACCURACY_WEIGHT = 0.1;

export interface TrustScoreRecord {
  sourceId: string;
  score: number;
  updatedAt: Date;
}

export function accuracyScore(predicted: number, actual: number): number {
  if (!Number.isFinite(predicted) || !Number.isFinite(actual) || actual <= 0) {
    throw new Error(
      'Predicted and actual yields must be finite, and actual yield must be positive',
    );
  }
  const relativeError = Math.abs(predicted - actual) / actual;
  return Math.max(0, 1 - relativeError);
}

export function updateTrustScore(previousScore: number, predicted: number, actual: number): number {
  if (!Number.isFinite(previousScore) || previousScore < 0) {
    throw new Error('Previous trust score must be a non-negative finite number');
  }
  const updated = TRUST_DECAY * previousScore + ACCURACY_WEIGHT * accuracyScore(predicted, actual);
  return Math.min(MAX_TRUST_SCORE, Math.max(MIN_TRUST_SCORE, updated));
}

export function updateTrust(
  sourceId: string,
  predicted: number,
  actual: number,
  existingScores: Map<string, TrustScoreRecord>,
): TrustScoreRecord {
  const previous = existingScores.get(sourceId)?.score ?? DEFAULT_TRUST_SCORE;
  const record = {
    sourceId,
    score: updateTrustScore(previous, predicted, actual),
    updatedAt: new Date(),
  };
  existingScores.set(sourceId, record);
  return record;
}
