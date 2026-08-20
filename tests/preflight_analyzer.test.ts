import { describe, it, expect, beforeEach } from 'vitest';
import { PreflightAnalyzer } from '../src/blockchain/preflight_analyzer';
import { SorobanRpcClient, RawSimulationResult } from '../src/blockchain/soroban_bridge';
import { TxBuilder } from '../src/blockchain/tx_builder';
import { PreflightOptions, ResourceFootprint } from '../src/blockchain/types';

class MockSorobanRpcClient extends SorobanRpcClient {
  private mockResult: RawSimulationResult | null = null;
  private shouldError: boolean = false;

  constructor() {
    super({ rpcUrl: 'http://mock', timeoutMs: 5000 });
  }

  setMockResult(result: RawSimulationResult): void {
    this.mockResult = result;
  }

  setShouldError(error: boolean): void {
    this.shouldError = error;
  }

  async simulateTransaction(_transactionXdr: string): Promise<RawSimulationResult> {
    if (this.shouldError || !this.mockResult) {
      throw new Error('Simulation failed');
    }
    return this.mockResult;
  }
}

describe('PreflightAnalyzer', () => {
  let mockRpc: MockSorobanRpcClient;
  let analyzer: PreflightAnalyzer;
  let defaultOptions: PreflightOptions;

  beforeEach(() => {
    mockRpc = new MockSorobanRpcClient();
    const txBuilder = new TxBuilder('Test SDF Network ; September 2015');
    analyzer = new PreflightAnalyzer(mockRpc, txBuilder);

    defaultOptions = {
      contractId: 'CCADCXN6NL25XF2MSQZ6AORQRIVYF6EDHO7MBLCR5CIG6YHVIMTJVV5C',
      functionName: 'hello',
      functionArgs: ['world'],
      sourceSecret: 'SDWINPDD5XPISBBPY43ILE77UFJ6GJV5BMDRTEE2V7WYDBZR6GJYDZTV',
      rpcUrl: 'http://mock',
      networkPassphrase: 'Test SDF Network ; September 2015',
    };
  });

  it('applies 1.2x safety multiplier to resource consumption', async () => {
    mockRpc.setMockResult({
      transactionData: 'AAAAAAAAAAAA',
      minResourceFee: 100,
      footprint: '',
      instructions: 50000,
      readBytes: 10000,
      writeBytes: 5000,
      ledgerEntriesRead: 5,
      ledgerEntriesWritten: 3,
    });

    const result = await analyzer.analyze(defaultOptions);

    expect(result.resourceFootprint.instructions).toBe(Math.ceil(50000 * 1.2));
    expect(result.resourceFootprint.readBytes).toBe(Math.ceil(10000 * 1.2));
    expect(result.resourceFootprint.writeBytes).toBe(Math.ceil(5000 * 1.2));
    expect(result.resourceFootprint.ledgerEntriesRead).toBe(Math.ceil(5 * 1.2));
    expect(result.resourceFootprint.ledgerEntriesWritten).toBe(Math.ceil(3 * 1.2));
  });

  it('returns minResourceFee with 1.2x multiplier', async () => {
    mockRpc.setMockResult({
      transactionData: 'AAAAAAMAAAAB',
      minResourceFee: 200,
      footprint: '',
      instructions: 30000,
      readBytes: 8000,
      writeBytes: 4000,
      ledgerEntriesRead: 3,
      ledgerEntriesWritten: 2,
    });

    const result = await analyzer.analyze(defaultOptions);
    expect(result.minResourceFee).toBe(Math.ceil(200 * 1.2));
  });

  it('clamps resource values to Soroban network maximums', async () => {
    mockRpc.setMockResult({
      transactionData: 'AAAAAAMAAAAB',
      minResourceFee: 500,
      footprint: '',
      instructions: 50_000_000,
      readBytes: 1_000_000,
      writeBytes: 500_000,
      ledgerEntriesRead: 200,
      ledgerEntriesWritten: 200,
    });

    const result = await analyzer.analyze(defaultOptions);

    expect(result.resourceFootprint.instructions).toBeLessThanOrEqual(10_000_000);
    expect(result.resourceFootprint.readBytes).toBeLessThanOrEqual(200_000);
    expect(result.resourceFootprint.writeBytes).toBeLessThanOrEqual(100_000);
    expect(result.resourceFootprint.ledgerEntriesRead).toBeLessThanOrEqual(50);
    expect(result.resourceFootprint.ledgerEntriesWritten).toBeLessThanOrEqual(50);
  });

  it('produces a valid base64 XDR envelope', async () => {
    mockRpc.setMockResult({
      transactionData: 'AAAAAAMAAAAB',
      minResourceFee: 150,
      footprint: '',
      instructions: 25000,
      readBytes: 5000,
      writeBytes: 2500,
      ledgerEntriesRead: 2,
      ledgerEntriesWritten: 1,
    });

    const result = await analyzer.analyze(defaultOptions);

    expect(result.transactionEnvelopeXdr).toBeTruthy();
    expect(typeof result.transactionEnvelopeXdr).toBe('string');
    expect(result.transactionEnvelopeXdr.length).toBeGreaterThan(0);

    const base64Regex = /^[A-Za-z0-9+/]+=*$/;
    expect(base64Regex.test(result.transactionEnvelopeXdr)).toBe(true);
  });

  it('throws PreflightError when RPC simulation fails', async () => {
    mockRpc.setShouldError(true);

    await expect(analyzer.analyze(defaultOptions)).rejects.toThrow('Simulation failed');
  });

  it('handles zero resource consumption gracefully', async () => {
    mockRpc.setMockResult({
      transactionData: 'AAAAAAMAAAAB',
      minResourceFee: 0,
      footprint: '',
      instructions: 0,
      readBytes: 0,
      writeBytes: 0,
      ledgerEntriesRead: 0,
      ledgerEntriesWritten: 0,
    });

    const result = await analyzer.analyze(defaultOptions);

    expect(result.resourceFootprint.instructions).toBe(0);
    expect(result.resourceFootprint.readBytes).toBe(0);
    expect(result.resourceFootprint.writeBytes).toBe(0);
    expect(result.resourceFootprint.ledgerEntriesRead).toBe(0);
    expect(result.resourceFootprint.ledgerEntriesWritten).toBe(0);
    expect(result.transactionEnvelopeXdr).toBeTruthy();
  });
});

describe('TxBuilder safety margin', () => {
  it('applies 1.2x multiplier and clamps to max', () => {
    const resources: ResourceFootprint = {
      instructions: 100,
      readBytes: 50,
      writeBytes: 30,
      ledgerEntriesRead: 5,
      ledgerEntriesWritten: 3,
    };

    const result = TxBuilder.applySafetyMargin(resources);

    expect(result.instructions).toBe(120);
    expect(result.readBytes).toBe(60);
    expect(result.writeBytes).toBe(36);
    expect(result.ledgerEntriesRead).toBe(6);
    expect(result.ledgerEntriesWritten).toBe(4);
  });

  it('clamps values exceeding network max', () => {
    const resources: ResourceFootprint = {
      instructions: 9_000_000,
      readBytes: 180_000,
      writeBytes: 90_000,
      ledgerEntriesRead: 45,
      ledgerEntriesWritten: 45,
    };

    const result = TxBuilder.applySafetyMargin(resources);

    expect(result.instructions).toBe(10_000_000);
    expect(result.readBytes).toBe(200_000);
    expect(result.writeBytes).toBe(100_000);
    expect(result.ledgerEntriesRead).toBe(50);
    expect(result.ledgerEntriesWritten).toBe(50);
  });
});
