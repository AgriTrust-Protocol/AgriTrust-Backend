import fs from 'node:fs/promises';
import { Pool } from 'pg';
import { ParcelService } from '../parcels/parcelService';
import { GeoJsonPolygon } from '../parcels/types';

interface GeoJsonFeature { type: 'Feature'; geometry: GeoJsonPolygon; properties?: Record<string, unknown>; }
interface GeoJsonFeatureCollection { type: 'FeatureCollection'; features: GeoJsonFeature[]; }

function readProperty(properties: Record<string, unknown> | undefined, names: string[]): string | undefined {
  for (const name of names) {
    const value = properties?.[name];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

async function readGeoJson(path: string): Promise<GeoJsonFeature[]> {
  const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as GeoJsonFeature | GeoJsonFeatureCollection;
  if (parsed.type === 'FeatureCollection') return parsed.features;
  if (parsed.type === 'Feature') return [parsed];
  throw new Error('GeoJSON import expects a Feature or FeatureCollection');
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: ts-node src/cli/import_parcels.ts <parcels.geojson>');
  if (!file.toLowerCase().endsWith('.geojson') && !file.toLowerCase().endsWith('.json')) {
    throw new Error('GeoJSON import is supported directly. Convert Shapefiles to GeoJSON before import.');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const service = new ParcelService(pool);
  const features = await readGeoJson(file);
  let imported = 0;
  let failed = 0;

  for (const [index, feature] of features.entries()) {
    try {
      if (feature.geometry?.type !== 'Polygon') throw new Error('Only Polygon parcel geometries are supported');
      await service.insertParcel(feature.geometry, {
        externalId: readProperty(feature.properties, ['external_id', 'externalId', 'parcel_id', 'id']),
        ownerId: readProperty(feature.properties, ['owner_id', 'ownerId']),
        metadata: feature.properties ?? {},
      });
      imported++;
    } catch (err) {
      failed++;
      console.error(`Feature ${index} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await pool.end();
  console.log(`Parcel import complete: imported=${imported} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
