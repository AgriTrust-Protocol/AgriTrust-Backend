import { Pool } from 'pg';
import { BBox, GeoJsonPolygon, ParcelFeature, ParcelProperties, ParcelQueryOptions } from './types';

function validateFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
}

export function parseBBox(value: string): BBox {
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4) throw new Error('bbox must contain SW_lng,SW_lat,NE_lng,NE_lat');
  const [swLng, swLat, neLng, neLat] = parts as BBox;
  [swLng, swLat, neLng, neLat].forEach((part, index) => validateFinite(part, `bbox[${index}]`));
  if (swLng >= neLng || swLat >= neLat)
    throw new Error('bbox southwest corner must be below and left of northeast corner');
  return [swLng, swLat, neLng, neLat];
}

export class ParcelService {
  constructor(private readonly pool: Pool) {}

  async queryParcels(
    options: ParcelQueryOptions,
  ): Promise<{ features: ParcelFeature[]; limit: number; offset: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    let distanceSelect = 'NULL::double precision AS distance_meters';

    if (options.bbox) {
      params.push(...options.bbox);
      where.push(
        `ST_Intersects(geom, ST_MakeEnvelope($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length}, 4326))`,
      );
    }

    if (
      options.lng !== undefined ||
      options.lat !== undefined ||
      options.distanceMeters !== undefined
    ) {
      if (
        options.lng === undefined ||
        options.lat === undefined ||
        options.distanceMeters === undefined
      ) {
        throw new Error('lng, lat, and distance_meters are required together');
      }
      validateFinite(options.lng, 'lng');
      validateFinite(options.lat, 'lat');
      validateFinite(options.distanceMeters, 'distance_meters');
      params.push(options.lng, options.lat, options.distanceMeters);
      const lngParam = params.length - 2;
      const latParam = params.length - 1;
      const distanceParam = params.length;
      const point = `ST_SetSRID(ST_MakePoint($${lngParam}, $${latParam}), 4326)`;
      where.push(`ST_DWithin(geom::geography, ${point}::geography, $${distanceParam})`);
      distanceSelect = `ST_Distance(geom::geography, ${point}::geography) AS distance_meters`;
    }

    params.push(options.limit, options.offset);
    const sql = `
      SELECT id::text, external_id, owner_id, properties,
             ST_AsGeoJSON(geom)::json AS geometry,
             ST_Area(geom::geography) AS area_square_meters,
             ${distanceSelect}
      FROM parcels
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const result = await this.pool.query(sql, params);
    return {
      features: result.rows.map((row) => ({
        id: row.id,
        externalId: row.external_id,
        ownerId: row.owner_id,
        areaSquareMeters: row.area_square_meters === null ? null : Number(row.area_square_meters),
        distanceMeters: row.distance_meters === null ? null : Number(row.distance_meters),
        properties: row.properties ?? {},
        geometry: row.geometry,
      })),
      limit: options.limit,
      offset: options.offset,
    };
  }

  async getGeometry(id: string): Promise<ParcelFeature | null> {
    const result = await this.pool.query(
      `SELECT id::text, external_id, owner_id, properties, ST_AsGeoJSON(geom)::json AS geometry,
              ST_Area(geom::geography) AS area_square_meters
       FROM parcels WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          externalId: row.external_id,
          ownerId: row.owner_id,
          areaSquareMeters: Number(row.area_square_meters),
          properties: row.properties ?? {},
          geometry: row.geometry,
        }
      : null;
  }

  async getBuffer(id: string, distanceMeters: number): Promise<GeoJsonPolygon | null> {
    validateFinite(distanceMeters, 'distance_meters');
    const result = await this.pool.query(
      `SELECT ST_AsGeoJSON(ST_Buffer(geom::geography, $2)::geometry)::json AS geometry
       FROM parcels WHERE id = $1`,
      [id, distanceMeters],
    );
    return result.rows[0]?.geometry ?? null;
  }

  async insertParcel(geometry: GeoJsonPolygon, properties: ParcelProperties): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO parcels (external_id, owner_id, properties, geom)
       VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))
       RETURNING id::text`,
      [
        properties.externalId ?? null,
        properties.ownerId ?? null,
        properties.metadata ?? {},
        JSON.stringify(geometry),
      ],
    );
    return result.rows[0].id;
  }
}
