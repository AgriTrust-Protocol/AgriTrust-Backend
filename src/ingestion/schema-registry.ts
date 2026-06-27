import fs from 'fs';
import path from 'path';
import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

export interface RegisteredTelemetrySchema {
  id: string;
  version: string;
  schema: Record<string, unknown>;
  validate: ValidateFunction;
}

export class SchemaRegistry {
  private readonly schemasByVersion = new Map<string, RegisteredTelemetrySchema>();
  private readonly schemasById = new Map<string, RegisteredTelemetrySchema>();
  private readonly ajv = new Ajv({ allErrors: true, strict: false });

  constructor(private readonly maxEntries = 256) {
    addFormats(this.ajv);
  }

  loadFromDirectory(schemaDir = path.join(__dirname, '..', 'schemas', 'telemetry')): void {
    const files = fs.readdirSync(schemaDir).filter((file) => /^v\d+\.json$/.test(file)).sort();
    for (const file of files) {
      const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, file), 'utf8')) as Record<string, unknown>;
      const id = schema.$id;
      if (typeof id !== 'string') throw new Error(`Schema ${file} is missing string $id`);
      this.register(id, path.basename(file, '.json'), schema);
    }
  }

  register(id: string, version: string, schema: Record<string, unknown>): void {
    if (!this.schemasById.has(id) && this.schemasById.size >= this.maxEntries) {
      throw new Error(`Schema registry limit of ${this.maxEntries} entries exceeded`);
    }
    const validate = this.ajv.compile(schema);
    const registered = { id, version, schema, validate };
    this.schemasById.set(id, registered);
    this.schemasByVersion.set(version, registered);
  }

  resolve(version: string): RegisteredTelemetrySchema | undefined {
    return this.schemasByVersion.get(version);
  }

  validate(version: string, payload: unknown): void {
    const schema = this.resolve(version);
    if (!schema) throw new Error(`Unknown schema version: ${version}`);
    if (!schema.validate(payload)) {
      throw new Error(`Invalid ${version} telemetry payload: ${this.ajv.errorsText(schema.validate.errors)}`);
    }
  }

  get size(): number {
    return this.schemasById.size;
  }
}
