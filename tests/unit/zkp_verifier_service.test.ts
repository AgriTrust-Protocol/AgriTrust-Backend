import { describe, expect, it } from 'vitest';
import {
  FarmerVerificationRateLimiter,
  FRAUD_REWARD_AGRI,
  InMemoryVerificationKeyRegistry,
  TARGET_VERIFICATION_LATENCY_MS,
  ZkProofVerifierService,
  generateOfflineProof,
  submitFraudProof,
  type ZkPublicInputs,
} from '../../src/zkp';

function inputs(i = 0): ZkPublicInputs {
  return {
    farmerId: `farmer-${i % 10}`,
    seasonId: '2026A',
    circuitType: i % 2 === 0 ? 'YieldCompliance' : 'SoilHealth',
    complianceResultHash: `0x${String(i).padStart(64, '0')}`,
    timestamp: 1_789_200_000 + i,
  };
}

describe('ZK proof verifier service', () => {
  it('stores active seasonal verification keys by circuit type', async () => {
    const registry = new InMemoryVerificationKeyRegistry();
    await registry.put({ circuitType: 'YieldCompliance', seasonId: '2026A', verificationKey: 'vk-v1', version: 1, active: true });
    await registry.put({ circuitType: 'YieldCompliance', seasonId: '2026A', verificationKey: 'vk-v2', version: 2, active: true });

    await expect(registry.get('YieldCompliance', '2026A')).resolves.toMatchObject({ verificationKey: 'vk-v2' });
  });

  it('verifies 1000 known correct and incorrect proofs accurately under latency target', async () => {
    const service = new ZkProofVerifierService();
    const verificationKey = 'seasonal-bls12-381-vk';
    const started = performance.now();

    for (let i = 0; i < 1000; i += 1) {
      const publicInputs = inputs(i);
      const validProof = generateOfflineProof(publicInputs, verificationKey);
      await expect(service.verifyProof(validProof, publicInputs, verificationKey)).resolves.toMatchObject({ valid: true });

      const invalidProof = { ...validProof, piA: ['00'.repeat(32), '0'] };
      await expect(service.verifyProof(invalidProof, publicInputs, verificationKey)).resolves.toMatchObject({ valid: false });
    }

    const averageLatencyMs = (performance.now() - started) / 2000;
    expect(averageLatencyMs).toBeLessThan(TARGET_VERIFICATION_LATENCY_MS);
  });

  it('records only valid verification results on-chain', async () => {
    const recorded: unknown[] = [];
    const service = new ZkProofVerifierService(undefined, {
      async recordVerification(result) {
        recorded.push(result);
        return 'tx-123';
      },
    });
    const publicInputs = inputs();
    const proof = generateOfflineProof(publicInputs, 'vk');

    await expect(service.verifyProof(proof, publicInputs, 'vk')).resolves.toMatchObject({ valid: true, txHash: 'tx-123' });
    await expect(service.verifyProof({ ...proof, piC: [] }, publicInputs, 'vk')).resolves.toMatchObject({ valid: false });
    expect(recorded).toHaveLength(1);
  });

  it('rate limits farmers to 1000 verifications per minute', () => {
    const limiter = new FarmerVerificationRateLimiter(1000);
    for (let i = 0; i < 1000; i += 1) expect(limiter.allow('farmer-1', 1_000).allowed).toBe(true);
    expect(limiter.allow('farmer-1', 1_000).allowed).toBe(false);
    expect(limiter.allow('farmer-1', 61_001).allowed).toBe(true);
  });

  it('accepts a circuit-bug fraud challenge and returns the AGRI reward amount', async () => {
    const publicInputs = inputs();
    const challenge = {
      challengerId: 'challenger-1',
      challengedTxHash: 'tx-123',
      circuitType: publicInputs.circuitType,
      seasonId: publicInputs.seasonId,
      proof: generateOfflineProof(publicInputs, 'vk'),
      publicInputs,
      verificationKey: 'vk',
      bugWitnessHash: `0x${'a'.repeat(64)}`,
    };

    await expect(submitFraudProof(challenge)).resolves.toMatchObject({ accepted: true, rewardAgri: FRAUD_REWARD_AGRI });
  });
});
