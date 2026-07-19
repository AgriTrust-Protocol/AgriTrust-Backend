import { PersistentEventConnector, SubscriptionTransport } from './base';
import { RawChainEvent } from '../types';

export class SorobanConnector extends PersistentEventConnector {
  constructor(transport: SubscriptionTransport) { super('stellar', transport); }
  protected decode(message: unknown): RawChainEvent[] {
    const events = Array.isArray(message) ? message : [message];
    return events.map((event: any) => ({
      chain: 'stellar',
      blockNumber: Number(event.ledger ?? event.blockNumber),
      blockHash: String(event.ledgerHash ?? event.blockHash),
      transactionHash: String(event.txHash ?? event.transactionHash),
      logIndex: Number(event.eventIndex ?? event.logIndex ?? 0),
      contractAddress: String(event.contractId ?? event.contractAddress),
      eventName: String(event.type ?? event.eventName),
      payload: event.value ?? event.payload ?? {},
      observedAt: new Date(),
    }));
  }
}
