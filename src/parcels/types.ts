export type BBox = [number, number, number, number];

export interface ParcelProperties {
  externalId?: string;
  ownerId?: string;
  metadata?: Record<string, unknown>;
}

export interface ParcelFeature {
  id: string;
  externalId: string | null;
  ownerId: string | null;
  areaSquareMeters: number | null;
  distanceMeters?: number | null;
  properties: Record<string, unknown>;
  geometry: GeoJsonPolygon;
}

export interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

export interface ParcelQueryOptions {
  bbox?: BBox;
  lng?: number;
  lat?: number;
  distanceMeters?: number;
  limit: number;
  offset: number;
}
