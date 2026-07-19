import { ProvenanceEventLog } from './event_log';
import { MmrPeak } from './mmr';

export interface ArchivedProvenancePeaks { archivedAt: Date; cutoff: Date; leafCount: number; peaks: MmrPeak[]; }

export class ProvenancePruner {
  readonly archive: ArchivedProvenancePeaks[] = [];
  constructor(private readonly eventLog: ProvenanceEventLog, private readonly retentionYears = 7) {}

  archiveExpired(now = new Date()): ArchivedProvenancePeaks | null {
    const cutoff = new Date(now);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - this.retentionYears);
    if (this.eventLog.recordsOlderThan(cutoff).length === 0) return null;
    const snapshot = { archivedAt: now, cutoff, leafCount: this.eventLog.leafCount, peaks: this.eventLog.peaks() };
    this.archive.push(snapshot);
    return snapshot;
  }
}
