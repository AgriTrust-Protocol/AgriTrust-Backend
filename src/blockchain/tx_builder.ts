import {
  Keypair,
  Account,
  TransactionBuilder,
  Operation,
  SorobanDataBuilder,
  xdr,
  Networks,
  Transaction,
} from '@stellar/stellar-sdk';
import { ResourceFootprint, SOROBAN_NETWORK_MAX } from './types';

export const SAFETY_MULTIPLIER = 1.2;

export class TxBuilder {
  private networkPassphrase: string;

  constructor(networkPassphrase: string = Networks.TESTNET) {
    this.networkPassphrase = networkPassphrase;
  }

  buildSimulationTx(
    sourcePubkey: string,
    contractId: string,
    functionName: string,
    functionArgs: xdr.ScVal[],
  ): Transaction {
    const sourceAccount = new Account(sourcePubkey, '0');

    const maxResources = new SorobanDataBuilder()
      .setResources(
        SOROBAN_NETWORK_MAX.instructions,
        SOROBAN_NETWORK_MAX.readBytes,
        SOROBAN_NETWORK_MAX.writeBytes,
      )
      .build();

    const tx = new TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
      sorobanData: maxResources,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: functionName,
          args: functionArgs,
        }),
      )
      .setTimeout(30)
      .build();

    return tx;
  }

  rebuildWithOptimizedResources(
    originalTx: Transaction,
    resources: ResourceFootprint,
    minResourceFee: number,
    footprintRead: xdr.LedgerKey[],
    footprintWrite: xdr.LedgerKey[],
  ): TransactionBuilder {
    const optimized = TxBuilder.applySafetyMargin(resources);

    const sorobanData = new SorobanDataBuilder()
      .setResources(optimized.instructions, optimized.readBytes, optimized.writeBytes)
      .setResourceFee(minResourceFee)
      .setReadOnly(footprintRead)
      .setReadWrite(footprintWrite)
      .build();

    return TransactionBuilder.cloneFrom(originalTx, {
      fee: String(Math.ceil(Number(originalTx.fee) + minResourceFee * SAFETY_MULTIPLIER)),
      sorobanData,
      networkPassphrase: this.networkPassphrase,
    });
  }

  signTransaction(txBuilder: TransactionBuilder, secretKey: string): string {
    const keypair = Keypair.fromSecret(secretKey);
    const tx = txBuilder.build();
    tx.sign(keypair);
    return tx.toEnvelope().toXDR('base64');
  }

  static scValFromArg(arg: string): xdr.ScVal {
    try {
      return xdr.ScVal.fromXDR(arg, 'base64');
    } catch {
      return xdr.ScVal.scvString(arg);
    }
  }

  static applySafetyMargin(resources: ResourceFootprint): ResourceFootprint {
    const clamp = (value: number, max: number): number =>
      Math.min(Math.ceil(value * SAFETY_MULTIPLIER), max);

    return {
      instructions: clamp(resources.instructions, SOROBAN_NETWORK_MAX.instructions),
      readBytes: clamp(resources.readBytes, SOROBAN_NETWORK_MAX.readBytes),
      writeBytes: clamp(resources.writeBytes, SOROBAN_NETWORK_MAX.writeBytes),
      ledgerEntriesRead: clamp(resources.ledgerEntriesRead, SOROBAN_NETWORK_MAX.ledgerEntriesRead),
      ledgerEntriesWritten: clamp(
        resources.ledgerEntriesWritten,
        SOROBAN_NETWORK_MAX.ledgerEntriesWritten,
      ),
    };
  }
}
