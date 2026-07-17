import { describe, expect, it } from 'vitest';
import { parseBBox } from '../../src/parcels/parcelService';

describe('parseBBox', () => {
  it('parses a valid southwest/northeast bounding box', () => {
    expect(parseBBox('-1.5,2,3.25,4')).toEqual([-1.5, 2, 3.25, 4]);
  });

  it('rejects reversed bounding boxes', () => {
    expect(() => parseBBox('3,2,-1,4')).toThrow(/southwest/);
  });
});
