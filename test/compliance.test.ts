import { test, describe } from 'node:test';
import assert from 'node:assert';
import OntologyParser from '../src/ontology/parser.js';
import EUDRProvenanceValidator, { LineageGraph } from '../src/compliance/eudr_provenance.js';
import VCEngine, { Certificate } from '../src/credentials/vc_engine.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('AgriTrust Core Tests', () => {
  test('Turtle ontology parsing', async () => {
    const parser = new OntologyParser();
    const store = await parser.loadOntology();
    assert.ok(store.size > 0, 'Ontology should have quads');
  });

  test('EUDR lineage graph verification', () => {
    const validator = new EUDRProvenanceValidator();
    const lineage: LineageGraph = {
      nodes: [
        {
          id: 'process1',
          timestamp: Date.UTC(2020, 5, 1),
          data: { type: 'planting', location: 'farm1' },
        },
        {
          id: 'process2',
          timestamp: Date.UTC(2020, 8, 1),
          data: { type: 'harvest', batchId: 'batch1' },
          parent: 'process1',
        },
      ],
      edges: [
        { from: 'process1', to: 'process2' },
      ],
    };
    const isValid = validator.verifyLineage(lineage);
    assert.strictEqual(isValid, true, 'Lineage should be verifiable');
  });

  test('EUDR evaluates deforestation cutoff correctly', () => {
    const validator = new EUDRProvenanceValidator();
    // Land cleared after Dec 31 2020 should be non-compliant
    const nonCompliant = validator.evaluateDeforestation({ geoPolygon: '[]' }, Date.UTC(2021, 0, 15));
    assert.strictEqual(nonCompliant, false, 'Should be non-compliant if cleared after cutoff');
    
    // Land cleared before cutoff should be compliant
    const compliant = validator.evaluateDeforestation({ geoPolygon: '[]' }, Date.UTC(2020, 5, 1));
    assert.strictEqual(compliant, true, 'Should be compliant if cleared before cutoff');
  });

  test('W3C Verifiable Credential signing', () => {
    const vcEngine = new VCEngine();
    const certificate: Certificate = {
      id: 'urn:uuid:test-123',
      type: ['VerifiableCredential', 'Certificate', 'Organic'],
      issuer: 'did:example:issuer',
      subject: 'did:example:farmer',
      claims: {
        certificationStatus: 'active',
        scope: 'organic',
      },
    };
    const vc = vcEngine.issueCredential(certificate);
    assert.ok(vc.proof, 'Credential should have proof');
    const verified = vcEngine.verifyCredential(vc);
    assert.strictEqual(verified, true, 'Credential signature should verify');
  });
});
