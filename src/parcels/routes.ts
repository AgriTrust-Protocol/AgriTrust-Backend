import { Router, Request, Response } from 'express';
import { ParcelService, parseBBox } from './parcelService';

function parsePagination(req: Request): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  if (!Number.isFinite(limit) || !Number.isFinite(offset)) throw new Error('limit and offset must be numbers');
  return { limit, offset };
}

function toFeatureCollection(features: Awaited<ReturnType<ParcelService['queryParcels']>>['features']) {
  return {
    type: 'FeatureCollection',
    features: features.map((parcel) => ({
      type: 'Feature',
      id: parcel.id,
      properties: {
        ...parcel.properties,
        externalId: parcel.externalId,
        ownerId: parcel.ownerId,
        areaSquareMeters: parcel.areaSquareMeters,
        distanceMeters: parcel.distanceMeters,
      },
      geometry: parcel.geometry,
    })),
  };
}

export function createParcelRouter(parcelService: ParcelService): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      const { limit, offset } = parsePagination(req);
      const bbox = typeof req.query.bbox === 'string' ? parseBBox(req.query.bbox) : undefined;
      const lng = req.query.lng === undefined ? undefined : Number(req.query.lng);
      const lat = req.query.lat === undefined ? undefined : Number(req.query.lat);
      const distanceMeters = req.query.distance_meters === undefined ? undefined : Number(req.query.distance_meters);
      const result = await parcelService.queryParcels({ bbox, lng, lat, distanceMeters, limit, offset });
      res.json({ ...toFeatureCollection(result.features), pagination: { limit: result.limit, offset: result.offset } });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid parcel query' });
    }
  });


  router.get('/:id/buffer', async (req: Request, res: Response) => {
    try {
      const distanceMeters = Number(req.query.distance_meters ?? 0);
      if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
        res.status(400).json({ error: 'distance_meters must be a positive number' });
        return;
      }
      const geometry = await parcelService.getBuffer(req.params.id as string, distanceMeters);
      if (!geometry) {
        res.status(404).json({ error: 'Parcel not found' });
        return;
      }
      res.json({ type: 'Feature', id: req.params.id, properties: { bufferDistanceMeters: distanceMeters }, geometry });
    } catch (err) {
      res.status(500).json({ error: 'Failed to buffer parcel geometry' });
    }
  });

  router.get('/:id/geometry', async (req: Request, res: Response) => {
    try {
      const parcel = await parcelService.getGeometry(req.params.id as string);
      if (!parcel) {
        res.status(404).json({ error: 'Parcel not found' });
        return;
      }
      res.json({
        type: 'Feature',
        id: parcel.id,
        properties: {
          ...parcel.properties,
          externalId: parcel.externalId,
          ownerId: parcel.ownerId,
          areaSquareMeters: parcel.areaSquareMeters,
        },
        geometry: parcel.geometry,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load parcel geometry' });
    }
  });

  return router;
}
