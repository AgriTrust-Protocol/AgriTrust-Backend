import { EventEmitter } from 'events';
import { ChainEventConnector, ChainName, RawChainEvent } from '../types';

export interface SubscriptionTransport {
  connect(onMessage: (message: unknown) => void): Promise<void>;
  close(): Promise<void>;
}

export abstract class PersistentEventConnector extends EventEmitter implements ChainEventConnector {
  private running = false;
  protected constructor(public readonly chain: ChainName, private readonly transport: SubscriptionTransport) { super(); }

  async start(onEvent: (event: RawChainEvent) => void | Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.transport.connect(async (message) => {
      for (const event of this.decode(message)) await onEvent(event);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.transport.close();
  }

  protected abstract decode(message: unknown): RawChainEvent[];
}
