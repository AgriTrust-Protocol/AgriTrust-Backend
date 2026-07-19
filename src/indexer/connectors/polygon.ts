import { PersistentEventConnector, SubscriptionTransport } from './base';
import { RawChainEvent } from '../types';

export class PolygonConnector extends PersistentEventConnector {
  constructor(transport: SubscriptionTransport) { super('polygon', transport); }
  protected decode(message: unknown): RawChainEvent[] { return decodeEvmLog('polygon', message); }
}

export function decodeEvmLog(chain: 'polygon' | 'celo', message: unknown): RawChainEvent[] {
  const logs = Array.isArray(message) ? message : [message];
  return logs.map((log: any) => ({
    chain,
    blockNumber: Number(log.blockNumber),
    blockHash: String(log.blockHash),
    transactionHash: String(log.transactionHash),
    logIndex: Number(log.logIndex ?? 0),
    contractAddress: String(log.address ?? log.contractAddress),
    eventName: String(log.eventName ?? log.event ?? log.name),
    payload: log.args ?? log.payload ?? {},
    observedAt: new Date(),
  }));
}
