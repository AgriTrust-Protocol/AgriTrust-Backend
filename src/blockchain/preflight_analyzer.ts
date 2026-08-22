import { Keypair } from '@stellar/stellar-sdk';
import { SorobanRpcClient, RawSimulationResult } from './soroban_bridge';
import { TxBuilder } from './tx_builder';
import { ResourceFootprint, PreflightResult, PreflightError, PreflightOptions } from './types';

export class PreflightAnalyzer {
  private rpcClient: SorobanRpcClient;
  private txBuilder: TxBuilder;

  constructor(rpcClient: SorobanRpcClient, txBuilder: TxBuilder) {
    this.rpcClient = rpcClient;
    this.txBuilder = txBuilder;
  }

  async analyze(options: PreflightOptions): Promise<PreflightResult> {
    const { contractId, functionName, functionArgs, sourceSecret } = options;

    const sourceKeypair = Keypair.fromSecret(sourceSecret);
    const sourcePubkey = sourceKeypair.publicKey();

    const scArgs = functionArgs.map(TxBuilder.scValFromArg);

    const simTx = this.txBuilder.buildSimulationTx(sourcePubkey, contractId, functionName, scArgs);
    const simTxXdr = simTx.toEnvelope().toXDR('base64');

    let rawSimResult: RawSimulationResult;
    try {
      rawSimResult = await this.rpcClient.simulateTransaction(simTxXdr);
    } catch (err) {
      throw new PreflightError(
        `Simulation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const rawResources: ResourceFootprint = {
      instructions: rawSimResult.instructions,
      readBytes: rawSimResult.readBytes,
      writeBytes: rawSimResult.writeBytes,
      ledgerEntriesRead: rawSimResult.ledgerEntriesRead,
      ledgerEntriesWritten: rawSimResult.ledgerEntriesWritten,
    };

    const txBuilder = this.txBuilder.rebuildWithOptimizedResources(
      simTx,
      rawResources,
      rawSimResult.minResourceFee,
      [],
      [],
    );

    const signedXdr = this.txBuilder.signTransaction(txBuilder, sourceSecret);

    const optimized = TxBuilder.applySafetyMargin(rawResources);

    return {
      resourceFootprint: optimized,
      minResourceFee: Math.ceil(rawSimResult.minResourceFee * 1.2),
      transactionEnvelopeXdr: signedXdr,
    };
  }
}
