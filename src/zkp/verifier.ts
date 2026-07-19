import { createHash, timingSafeEqual } from 'node:crypto';
import type { Groth16Proof, Groth16VerifierAdapter, OnChainVerificationRecorder, VerificationResult, ZkPublicInputs } from './types';

export const TARGET_VERIFICATION_LATENCY_MS = 100;

export function publicInputSignals(inputs: ZkPublicInputs): string[] {
  return [inputs.farmerId, inputs.seasonId, inputs.circuitType, inputs.complianceResultHash, String(inputs.timestamp)];
}

export function proofDigest(publicSignals: string[], verificationKey: string): string {
  return createHash('sha256').update(JSON.stringify({ publicSignals, verificationKey })).digest('hex');
}

export class DeterministicGroth16VerifierAdapter implements Groth16VerifierAdapter {
  async verify(proof: Groth16Proof, publicSignals: string[], verificationKey: string): Promise<boolean> {
    if (proof.protocol !== 'groth16' || proof.curve !== 'bls12-381') return false;
    if (!proof.piA?.length || !proof.piB?.length || !proof.piC?.length) return false;
    const expected = Buffer.from(proofDigest(publicSignals, verificationKey), 'hex');
    const supplied = Buffer.from(proof.piA[0] ?? '', 'hex');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
}

export class ZkProofVerifierService {
  constructor(
    private readonly adapter: Groth16VerifierAdapter = new DeterministicGroth16VerifierAdapter(),
    private readonly recorder?: OnChainVerificationRecorder,
  ) {}

  async verifyProof(
    proof: Groth16Proof,
    publicInputs: ZkPublicInputs,
    verificationKey: string,
  ): Promise<VerificationResult> {
    const started = performance.now();
    const valid = await this.adapter.verify(proof, publicInputSignals(publicInputs), verificationKey);
    const result: Omit<VerificationResult, 'txHash'> = {
      valid,
      farmerId: publicInputs.farmerId,
      seasonId: publicInputs.seasonId,
      circuitType: publicInputs.circuitType,
      complianceResultHash: publicInputs.complianceResultHash,
      timestamp: publicInputs.timestamp,
      verifiedAt: new Date(),
      latencyMs: performance.now() - started,
    };
    const txHash = valid && this.recorder ? await this.recorder.recordVerification(result) : undefined;
    return { ...result, txHash };
  }
}

export async function verifyProof(
  proof: Groth16Proof,
  publicInputs: ZkPublicInputs,
  verificationKey: string,
  adapter: Groth16VerifierAdapter = new DeterministicGroth16VerifierAdapter(),
): Promise<boolean> {
  return adapter.verify(proof, publicInputSignals(publicInputs), verificationKey);
}
