export type CircuitType = 'YieldCompliance' | 'SoilHealth' | 'TreatmentAudit' | 'ProvenanceChain';

export interface Groth16Proof {
  protocol: 'groth16';
  curve: 'bls12-381';
  piA: string[];
  piB: string[][];
  piC: string[];
}

export interface ZkPublicInputs {
  farmerId: string;
  seasonId: string;
  circuitType: CircuitType;
  complianceResultHash: string;
  timestamp: number;
}

export interface VerificationKeyRecord {
  circuitType: CircuitType;
  seasonId: string;
  verificationKey: string;
  version: number;
  active: boolean;
  createdAt: Date;
}

export interface VerificationResult {
  valid: boolean;
  farmerId: string;
  seasonId: string;
  circuitType: CircuitType;
  complianceResultHash: string;
  timestamp: number;
  verifiedAt: Date;
  latencyMs: number;
  txHash?: string;
}

export interface OnChainVerificationRecorder {
  recordVerification(result: Omit<VerificationResult, 'txHash'>): Promise<string>;
}

export interface Groth16VerifierAdapter {
  verify(proof: Groth16Proof, publicSignals: string[], verificationKey: string): Promise<boolean>;
}
