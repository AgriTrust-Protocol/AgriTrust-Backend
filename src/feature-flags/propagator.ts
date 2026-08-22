/**
 * Propagator — Redis Pub/Sub subscriber for real-time config changes.
 *
 * Subscribes to the `feature-flag:update` channel.
 * On each message it applies a delta patch to the local FeatureEngine,
 * keeping eventual consistency ≤ 5 s across all nodes.
 *
 * Message envelope (JSON):
 *   { action: 'upsert' | 'delete', flag?: FlagDefinition, key?: string }
 */

import { FeatureEngine, FlagDefinition } from './engine';
import { ConfigStore } from './config-store';

export const PROPAGATION_CHANNEL = 'feature-flag:update';

export type PropagationAction =
  { action: 'upsert'; flag: FlagDefinition } | { action: 'delete'; key: string };

/** Minimal interface for the subscribe-only Redis connection. */
export interface RedisPubSubClient {
  subscribe(channel: string): Promise<void>;
  on(event: 'message', listener: (channel: string, message: string) => void): this;
  disconnect?(): void;
  quit?(): Promise<void>;
}

/** Minimal interface for the publish connection. */
export interface RedisPublishClient {
  publish(channel: string, message: string): Promise<number>;
}

export class Propagator {
  private subscriber?: RedisPubSubClient;

  constructor(
    private readonly engine: FeatureEngine,
    private readonly store: ConfigStore,
  ) {}

  /**
   * Start listening.  Pass a *separate* Redis connection — ioredis requires
   * a dedicated client once subscribe() is called.
   */
  async start(subscriber: RedisPubSubClient): Promise<void> {
    this.subscriber = subscriber;
    await subscriber.subscribe(PROPAGATION_CHANNEL);

    subscriber.on('message', (channel, message) => {
      if (channel !== PROPAGATION_CHANNEL) return;
      this.handleMessage(message);
    });
  }

  async stop(): Promise<void> {
    if (this.subscriber) {
      if (this.subscriber.quit) {
        await this.subscriber.quit();
      } else if (this.subscriber.disconnect) {
        this.subscriber.disconnect();
      }
      this.subscriber = undefined;
    }
  }

  /**
   * Publish a change so all nodes receive and apply it.
   * Call this after every admin API mutation.
   */
  static async publish(publisher: RedisPublishClient, patch: PropagationAction): Promise<void> {
    await publisher.publish(PROPAGATION_CHANNEL, JSON.stringify(patch));
  }

  // ── Private ──────────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let patch: PropagationAction;
    try {
      patch = JSON.parse(raw) as PropagationAction;
    } catch {
      console.warn('[Propagator] Received malformed message — skipping');
      return;
    }

    try {
      if (patch.action === 'upsert' && patch.flag) {
        this.engine.setFlag(patch.flag);
        // Also keep Redis hash in sync (best-effort)
        this.store.upsertFlag(patch.flag).catch(() => undefined);
      } else if (patch.action === 'delete' && patch.key) {
        this.engine.deleteFlag(patch.key);
        this.store.deleteFlag(patch.key).catch(() => undefined);
      }
    } catch (err) {
      console.error('[Propagator] Failed to apply patch:', err);
    }
  }
}
