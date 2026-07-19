export enum ProvenanceEventType {
  Planting = 'Planting',
  Harvest = 'Harvest',
  Treatment = 'Treatment',
  Transfer = 'Transfer',
  StorageReading = 'Storage_Reading',
  Processing = 'Processing',
  Shipment = 'Shipment',
  Sale = 'Sale',
}

export type Hash = Buffer;

export interface ProvenanceEvent {
  eventId: Buffer;
  prevEventHash: Buffer;
  payloadHash: Buffer;
  timestamp: number;
  location: [number, number];
  type: ProvenanceEventType;
}

export interface SerializedProvenanceEvent {
  event_id: string;
  prev_event_hash: string;
  payload_hash: string;
  timestamp: number;
  location: [number, number];
  type: ProvenanceEventType;
}

export interface ProvenanceRecord {
  event: ProvenanceEvent;
  hash: Buffer;
  leafIndex: number;
  appendedAt: Date;
}

export function assertHash(value: Buffer, field: string): void {
  if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error(`${field} must be a 32-byte Buffer`);
}

export function serializeEvent(event: ProvenanceEvent): Buffer {
  assertHash(event.eventId, 'eventId');
  assertHash(event.prevEventHash, 'prevEventHash');
  assertHash(event.payloadHash, 'payloadHash');
  const timestamp = Buffer.allocUnsafe(8);
  timestamp.writeBigUInt64BE(BigInt(event.timestamp));
  const location = Buffer.allocUnsafe(16);
  location.writeDoubleBE(event.location[0], 0);
  location.writeDoubleBE(event.location[1], 8);
  return Buffer.concat([Buffer.from(event.type), Buffer.from([0]), event.eventId, event.prevEventHash, event.payloadHash, timestamp, location]);
}

export function eventToJson(event: ProvenanceEvent): SerializedProvenanceEvent {
  return {
    event_id: event.eventId.toString('hex'),
    prev_event_hash: event.prevEventHash.toString('hex'),
    payload_hash: event.payloadHash.toString('hex'),
    timestamp: event.timestamp,
    location: event.location,
    type: event.type,
  };
}
