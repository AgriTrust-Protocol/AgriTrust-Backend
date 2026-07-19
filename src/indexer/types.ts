export type ChainName = 'polygon' | 'celo' | 'stellar';
export type DomainEventType = 'yield_published' | 'settlement_executed' | 'provenance_updated' | 'insurance_claimed';

export interface RawChainEvent {
  chain: ChainName;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  contractAddress: string;
  eventName: string;
  payload: Record<string, unknown>;
  observedAt?: Date;
}

export interface DomainEvent {
  id: string;
  chain: ChainName;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  type: DomainEventType;
  farmId: string;
  season?: string;
  occurredAt: Date;
  data: Record<string, unknown>;
}

export interface IndexerCursor {
  chain: ChainName;
  lastBlock: number;
  blockHash?: string;
  updatedAt: Date;
}

export interface ChainEventConnector {
  readonly chain: ChainName;
  start(onEvent: (event: RawChainEvent) => void | Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
