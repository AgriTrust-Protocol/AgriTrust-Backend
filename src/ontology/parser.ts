import * as fs from 'fs';
import * as path from 'path';
import { Parser, Store } from 'n3';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class OntologyParser {
  private store: Store;

  constructor() {
    this.store = new Store();
  }

  async loadOntology(filePath?: string): Promise<Store> {
    const ontologyPath = filePath || path.join(__dirname, 'agritrust_core.ttl');
    const ttlContent = fs.readFileSync(ontologyPath, 'utf-8');
    const parser = new Parser();
    parser.parse(ttlContent, (error, quad) => {
      if (error) {
        throw new Error(`Failed to parse ontology: ${error.message}`);
      }
      if (quad) {
        this.store.addQuad(quad);
      }
    });
    return this.store;
  }

  getStore(): Store {
    return this.store;
  }

  query(pattern: { subject?: string; predicate?: string; object?: string }): Array<any> {
    return this.store.getQuads(pattern.subject, pattern.predicate, pattern.object, null);
  }
}

export default OntologyParser;
