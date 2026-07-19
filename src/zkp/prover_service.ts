import type { Groth16Proof, ZkPublicInputs } from './types';
import { proofDigest, publicInputSignals } from './verifier';

export function generateOfflineProof(publicInputs: ZkPublicInputs, verificationKey: string): Groth16Proof {
  return {
    protocol: 'groth16',
    curve: 'bls12-381',
    piA: [proofDigest(publicInputSignals(publicInputs), verificationKey), '0'],
    piB: [['0', '1'], ['1', '0']],
    piC: ['0', '1'],
  };
}
