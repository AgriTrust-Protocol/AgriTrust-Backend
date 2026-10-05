import * as crypto from 'crypto';

export interface ProcessNode {
  id: string;
  timestamp: number;
  data: Record<string, any>;
  parent?: string;
}

export interface LineageGraph {
  nodes: ProcessNode[];
  edges: Array<{ from: string; to: string }>;
}

export interface Observation {
  geoPolygon: string;
  coordinates?: number[][];
  timestamp?: number;
}

export class EUDRProvenanceValidator {
  private readonly CUTOFF_DATE = new Date('2021-01-01T00:00:00Z'); // December 31, 2020 cutoff means land cleared after this? 
  // EUDR: production on land deforested after 31 December 2020 is not allowed
  // So if land was cleared after Dec 31 2020, non-compliant
  private readonly CUTOFF_TIMESTAMP = Date.UTC(2020, 11, 31, 23, 59, 59, 999); // End of 2020-12-31

  evaluateDeforestation(observation: Observation, clearanceTimestamp?: number): boolean {
    // If clearance happened after cutoff, it's non-compliant (returns false for compliance)
    if (clearanceTimestamp !== undefined && clearanceTimestamp > this.CUTOFF_TIMESTAMP) {
      return false;
    }
    return true;
  }

  computeMerkleRoot(lineage: LineageGraph): string {
    if (lineage.nodes.length === 0) {
      return this.hash('');
    }

    let hashes = lineage.nodes
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => {
        const nodeData = JSON.stringify({
          id: node.id,
          timestamp: node.timestamp,
          parent: node.parent,
          data: node.data,
        });
        return this.hash(nodeData);
      });

    while (hashes.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < hashes.length; i += 2) {
        if (i + 1 < hashes.length) {
          nextLevel.push(this.hash(hashes[i] + hashes[i + 1]));
        } else {
          nextLevel.push(this.hash(hashes[i] + hashes[i]));
        }
      }
      hashes = nextLevel;
    }

    return hashes[0];
  }

  private hash(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  verifyLineage(lineage: LineageGraph): boolean {
    try {
      const computedRoot = this.computeMerkleRoot(lineage);
      return computedRoot.length === 64; // Valid SHA-256 hex
    } catch (error) {
      return false;
    }
  }
}

export default EUDRProvenanceValidator;
