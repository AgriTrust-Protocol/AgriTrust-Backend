import { createHash, randomBytes } from 'crypto';
import { describe, expect, it } from 'vitest';
import { ProvenanceEventLog, ProvenanceEventType, verifyInclusion } from '../../src/provenance';

function eventAt(i: number) {
  const id = createHash('sha256').update(`event-${i}`).digest();
  const prev = i === 0 ? Buffer.alloc(32) : createHash('sha256').update(`event-${i - 1}`).digest();
  return { eventId: id, prevEventHash: prev, payloadHash: randomBytes(32), timestamp: i, location: [6.45, 3.39] as [number, number], type: ProvenanceEventType.Transfer };
}

describe('provenance Merkle Mountain Range', () => {
  it('verifies every inclusion proof against the latest root', () => {
    const log = new ProvenanceEventLog();
    const events = Array.from({ length: 10_000 }, (_, i) => eventAt(i));
    for (const event of events) log.appendEvent(event);
    const root = log.root;
    for (const event of events) expect(verifyInclusion(log.proveInclusion(event.eventId), root)).toBe(true);
  });

  it('rejects a proof for the wrong root', () => {
    const log = new ProvenanceEventLog();
    const record = log.appendEvent(eventAt(1));
    expect(verifyInclusion(log.proveInclusion(record.event.eventId), Buffer.alloc(32))).toBe(false);
  });
});
