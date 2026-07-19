import { PersistentEventConnector, SubscriptionTransport } from './base';
import { RawChainEvent } from '../types';
import { decodeEvmLog } from './polygon';

export class CeloConnector extends PersistentEventConnector {
  constructor(transport: SubscriptionTransport) { super('celo', transport); }
  protected decode(message: unknown): RawChainEvent[] { return decodeEvmLog('celo', message); }
}
