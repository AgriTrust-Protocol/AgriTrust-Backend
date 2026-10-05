import { Router, Request, Response } from 'express';
import OntologyParser from '../ontology/parser.js';
import EUDRProvenanceValidator, { LineageGraph, Observation } from '../compliance/eudr_provenance.js';
import VCEngine, { Certificate } from '../credentials/vc_engine.js';
import * as crypto from 'crypto';

const router = Router();
const ontologyParser = new OntologyParser();
const eudrValidator = new EUDRProvenanceValidator();
const vcEngine = new VCEngine();

// Initialize ontology on load
ontologyParser.loadOntology().catch((err) => {
  console.error('Failed to load ontology:', err);
});

router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

router.post('/api/ontology/query', (req: Request, res: Response) => {
  try {
    const { subject, predicate, object } = req.body || {};
    const results = ontologyParser.query({ subject, predicate, object });
    res.json({ results: results.map((q) => q.toJSON()) });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/api/compliance/eudr/evaluate', (req: Request, res: Response) => {
  try {
    const { geoPolygon, coordinates, timestamp, clearanceTimestamp, farmerDid, batchId } = req.body || {};
    
    const observation: Observation = {
      geoPolygon: geoPolygon || JSON.stringify(coordinates),
      coordinates,
      timestamp,
    };

    const isCompliant = eudrValidator.evaluateDeforestation(observation, clearanceTimestamp);
    
    // Issue compliance credential if compliant
    const certificate: Certificate = {
      id: `urn:uuid:${crypto.randomUUID()}`,
      type: ['VerifiableCredential', 'DeforestationFreeProof', 'Certificate'],
      issuer: 'https://agritrust.example.org/issuer',
      subject: farmerDid || 'did:example:farmer',
      claims: {
        batchId,
        compliant: isCompliant,
        evaluatedAt: new Date().toISOString(),
        regulation: 'EUDR',
      },
    };

    const credential = vcEngine.issueCredential(certificate);
    
    res.json({
      compliant: isCompliant,
      credential,
      observation,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/api/contracts/odrl/compile', (req: Request, res: Response) => {
  try {
    const { terms, policyId } = req.body || {};
    
    const odrlPolicy = {
      '@context': 'http://www.w3.org/ns/odrl/2/',
      '@type': 'Offer',
      uid: policyId || `urn:uuid:${crypto.randomUUID()}`,
      profile: 'https://agritrust.example.org/odrl-profile',
      permission: terms?.permission || [],
      prohibition: terms?.prohibition || [],
      obligation: terms?.obligation || [],
    };

    const policyHash = crypto.createHash('sha256').update(JSON.stringify(odrlPolicy)).digest('hex');
    
    res.json({
      policy: odrlPolicy,
      hash: policyHash,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
