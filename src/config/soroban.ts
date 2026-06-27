export const sorobanConfig = {
  srvRecord: process.env.SOROBAN_SRV_RECORD || '_soroban._tcp.network.example.com',
  discoveryIntervalMs: 60_000,
  healthCheckIntervalMs: 5_000,
  affinityTimeoutMs: 30_000,
  degradedTimeoutMs: 60_000,
  recoveryDurationMs: 120_000,
  weights: {
    minWeight: 0.01,
    initialRecoveryWeight: 0.1,
    recoveryStepIntervalMs: 15_000,
  },
  p99ThresholdMs: 50,
};
