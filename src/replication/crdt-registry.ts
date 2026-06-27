export type HybridTimestamp = { wallTime: number; logical: number; nodeId: string };

export function compareTimestamp(a: HybridTimestamp, b: HybridTimestamp): number {
  if (a.wallTime !== b.wallTime) return a.wallTime - b.wallTime;
  if (a.logical !== b.logical) return a.logical - b.logical;
  return a.nodeId.localeCompare(b.nodeId);
}

export interface CRDT<TSnapshot> {
  merge(other: this): this;
  toSnapshot(): TSnapshot;
}

export type LWWRegisterSnapshot<T> = { value: T; timestamp: HybridTimestamp };

export class LWWRegister<T> implements CRDT<LWWRegisterSnapshot<T>> {
  constructor(public value: T, public timestamp: HybridTimestamp) {}

  set(value: T, timestamp: HybridTimestamp): this {
    if (compareTimestamp(timestamp, this.timestamp) >= 0) {
      this.value = value;
      this.timestamp = timestamp;
    }
    return this;
  }

  merge(other: this): this {
    return this.set(other.value, other.timestamp);
  }

  toSnapshot(): LWWRegisterSnapshot<T> {
    return { value: this.value, timestamp: { ...this.timestamp } };
  }

  static fromSnapshot<T>(snapshot: LWWRegisterSnapshot<T>): LWWRegister<T> {
    return new LWWRegister(snapshot.value, { ...snapshot.timestamp });
  }
}

export type ORSetSnapshot<T extends string> = {
  adds: Record<T, string[]>;
  removes: Record<T, string[]>;
};

export class ORSet<T extends string> implements CRDT<ORSetSnapshot<T>> {
  private adds = new Map<T, Set<string>>();
  private removes = new Map<T, Set<string>>();

  add(value: T, tag: string): this {
    if (!this.adds.has(value)) this.adds.set(value, new Set());
    this.adds.get(value)!.add(tag);
    return this;
  }

  remove(value: T): this {
    const tags = this.adds.get(value);
    if (!tags) return this;
    if (!this.removes.has(value)) this.removes.set(value, new Set());
    for (const tag of tags) this.removes.get(value)!.add(tag);
    return this;
  }

  values(): T[] {
    return [...this.adds.entries()]
      .filter(([value, tags]) => [...tags].some((tag) => !this.removes.get(value)?.has(tag)))
      .map(([value]) => value);
  }

  merge(other: this): this {
    mergeMapSet(this.adds, other.adds);
    mergeMapSet(this.removes, other.removes);
    return this;
  }

  toSnapshot(): ORSetSnapshot<T> {
    return { adds: mapSetToRecord(this.adds), removes: mapSetToRecord(this.removes) };
  }

  static fromSnapshot<T extends string>(snapshot: ORSetSnapshot<T>): ORSet<T> {
    const set = new ORSet<T>();
    set.adds = recordToMapSet(snapshot.adds);
    set.removes = recordToMapSet(snapshot.removes);
    return set;
  }
}

export type PNCounterSnapshot = { increments: Record<string, number>; decrements: Record<string, number> };

export class PNCounter implements CRDT<PNCounterSnapshot> {
  private increments = new Map<string, number>();
  private decrements = new Map<string, number>();

  increment(replicaId: string, amount = 1): this {
    this.increments.set(replicaId, (this.increments.get(replicaId) ?? 0) + amount);
    return this;
  }

  decrement(replicaId: string, amount = 1): this {
    this.decrements.set(replicaId, (this.decrements.get(replicaId) ?? 0) + amount);
    return this;
  }

  value(): number {
    return sum(this.increments) - sum(this.decrements);
  }

  merge(other: this): this {
    mergeMax(this.increments, other.increments);
    mergeMax(this.decrements, other.decrements);
    return this;
  }

  toSnapshot(): PNCounterSnapshot {
    return { increments: Object.fromEntries(this.increments), decrements: Object.fromEntries(this.decrements) };
  }

  static fromSnapshot(snapshot: PNCounterSnapshot): PNCounter {
    const counter = new PNCounter();
    counter.increments = new Map(Object.entries(snapshot.increments));
    counter.decrements = new Map(Object.entries(snapshot.decrements));
    return counter;
  }
}

export type ApplicationCRDTState = {
  batchStatus: LWWRegister<string>;
  escrowState: LWWRegister<string>;
  attestations: ORSet<string>;
  inventory: PNCounter;
};

function mergeMapSet<T>(target: Map<T, Set<string>>, source: Map<T, Set<string>>): void {
  for (const [key, values] of source) {
    if (!target.has(key)) target.set(key, new Set());
    for (const value of values) target.get(key)!.add(value);
  }
}
function mergeMax(target: Map<string, number>, source: Map<string, number>): void {
  for (const [key, value] of source) target.set(key, Math.max(target.get(key) ?? 0, value));
}
function sum(values: Map<string, number>): number { return [...values.values()].reduce((a, b) => a + b, 0); }
function mapSetToRecord<T extends string>(map: Map<T, Set<string>>): Record<T, string[]> { return Object.fromEntries([...map].map(([k, v]) => [k, [...v]])) as Record<T, string[]>; }
function recordToMapSet<T extends string>(record: Record<T, string[]>): Map<T, Set<string>> { return new Map(Object.entries(record).map(([k, v]) => [k as T, new Set(v as string[])])); }
