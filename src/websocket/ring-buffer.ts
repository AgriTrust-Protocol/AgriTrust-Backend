/**
 * AgriTrust Backend – Bounded Ring Buffer for Connection Lifecycle Events
 *
 * Fixed-capacity circular buffer with O(1) push and O(1) eviction.
 * Used by the ConnectionManager to track connection lifecycle entries
 * without unbounded memory growth.
 */

import { RING_BUFFER_CAPACITY } from '../config/websocket';

export interface LifecycleEntry {
  socketId: string;
  /** Epoch-ms when the connection was first established. */
  connectedAt: number;
  /** Epoch-ms of the most recent frame received. */
  lastActivityAt: number;
  /** Epoch-ms when the connection was closed (0 while open). */
  closedAt: number;
}

export class RingBuffer<T = LifecycleEntry> {
  private readonly items: (T | undefined)[];
  private head = 0;
  private _size = 0;
  readonly capacity: number;

  constructor(capacity: number = RING_BUFFER_CAPACITY) {
    this.capacity = capacity;
    this.items = new Array<T | undefined>(capacity);
  }

  /** Push an entry; evicts the oldest if full. Returns the evicted entry or undefined. */
  push(entry: T): T | undefined {
    let evicted: T | undefined;
    if (this._size === this.capacity) {
      evicted = this.items[this.head];
    }
    const idx = (this.head + this._size) % this.capacity;
    this.items[idx] = entry;
    if (this._size < this.capacity) {
      this._size++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
    return evicted;
  }

  /** Number of entries currently stored. */
  get size(): number {
    return this._size;
  }

  /** Iterate all entries oldest → newest. */
  *[Symbol.iterator](): IterableIterator<T> {
    for (let i = 0; i < this._size; i++) {
      const idx = (this.head + i) % this.capacity;
      yield this.items[idx] as T;
    }
  }

  /** Return the entry at logical index (0 = oldest). */
  at(index: number): T | undefined {
    if (index < 0 || index >= this._size) return undefined;
    return this.items[(this.head + index) % this.capacity];
  }

  /** Peek at the oldest entry without removing it. */
  peek(): T | undefined {
    if (this._size === 0) return undefined;
    return this.items[this.head];
  }

  /** Remove and return the oldest entry. */
  shift(): T | undefined {
    if (this._size === 0) return undefined;
    const entry = this.items[this.head];
    this.items[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this._size--;
    return entry;
  }

  /** Clear all entries. */
  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this._size = 0;
  }
}
