import type { CircuitType, Groth16Proof, ZkPublicInputs } from './types';
import { publicInputSignals, verifyProof } from './verifier';

export const FRAUD_REWARD_AGRI = 100;

export interface FraudChallenge {
  challengerId: string;
  challengedTxHash: string;
  circuitType: CircuitType;
  seasonId: string;
  proof: Groth16Proof;
  publicInputs: ZkPublicInputs;
  verificationKey: string;
  bugWitnessHash: string;
}

export interface FraudChallengeResult {
  accepted: boolean;
  rewardAgri: number;
  reason: string;
}

export async function submitFraudProof(challenge: FraudChallenge): Promise<FraudChallengeResult> {
  const stillVerifies = await verifyProof(challenge.proof, challenge.publicInputs, challenge.verificationKey);
  const matchesCircuit = challenge.publicInputs.circuitType === challenge.circuitType
    && challenge.publicInputs.seasonId === challenge.seasonId;
  const hasWitness = /^0x[0-9a-f]{64}$/i.test(challenge.bugWitnessHash);

  if (stillVerifies && matchesCircuit && hasWitness && publicInputSignals(challenge.publicInputs).length === 5) {
    return { accepted: true, rewardAgri: FRAUD_REWARD_AGRI, reason: 'fraud_proof_accepted' };
  }
  return { accepted: false, rewardAgri: 0, reason: 'fraud_proof_rejected' };
}
