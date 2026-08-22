import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MintService } from '../../src/certificate/mintService';

describe('MintService Race Condition (Unit/Mock)', () => {
  let mockPool: any;
  let mockClient: any;
  let mintService: MintService;

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    };
    mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      query: vi.fn(),
    };
    mintService = new MintService(mockPool as any);
  });

  it('prevents double minting by using pg_advisory_lock', async () => {
    const batchId = 'test_batch_123';

    // Simulate first call acquiring lock and proceeding
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // select check
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // insert intent
      .mockResolvedValueOnce({ rows: [] }); // update success

    const result = await mintService.mintCertificate(batchId, {});

    expect(result.success).toBe(true);
    expect(mockClient.query).toHaveBeenCalledWith('SELECT pg_advisory_lock($1)', [
      expect.any(BigInt),
    ]);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO certificates'),
      expect.anything(),
    );
  });

  it('returns existing certificate if already minted', async () => {
    const batchId = 'already_minted';

    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ certificate_id: 'cert_existing', status: 'minted' }] });

    const result = await mintService.mintCertificate(batchId, {});

    expect(result.success).toBe(true);
    expect(result.certificateId).toBe('cert_existing');
    // Should NOT try to insert or update
    expect(mockClient.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO certificates'),
      expect.anything(),
    );
  });

  it('returns error if minting is already in progress', async () => {
    const batchId = 'in_progress';

    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ status: 'minting' }] });

    const result = await mintService.mintCertificate(batchId, {});

    expect(result.success).toBe(false);
    expect(result.error).toBe('Minting already in progress');
  });

  it('handles race condition where insert fails due to unique constraint', async () => {
    const batchId = 'race_insert';

    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // select check sees nothing
      .mockResolvedValueOnce({ rows: [] }) // insert fails (returns 0 rows because of ON CONFLICT DO NOTHING)
      .mockResolvedValueOnce({ rows: [{ certificate_id: 'cert_from_race', status: 'minted' }] }); // re-check sees it now

    const result = await mintService.mintCertificate(batchId, {});

    expect(result.success).toBe(true);
    expect(result.certificateId).toBe('cert_from_race');
  });
});
