import { Request, Response } from 'express';
import { z } from 'zod';
import * as scanService from '../services/scan.service';

/**
 * Upload accepts a JSON body with base64 images (works within the 12mb JSON
 * limit and is what the Flutter client posts):
 *   { front: "<base64|dataURL>", closeup?: "...", geometry: { ... } }
 */
const uploadSchema = z.object({
  front: z.string().min(1, 'front image is required'),
  closeup: z.string().min(1).optional(),
  geometry: z.record(z.string(), z.unknown()),
});

export async function upload(req: Request, res: Response): Promise<void> {
  const { front, closeup, geometry } = uploadSchema.parse(req.body);

  const result = await scanService.createScanFromUpload({
    userId: req.userId, // optionalAuth — may be undefined (anonymous first scan)
    front: scanService.decodeBase64Image(front),
    closeup: closeup ? scanService.decodeBase64Image(closeup) : undefined,
    geometry: geometry as scanService.Geometry,
  });

  res.status(201).json(result);
}

export async function getById(req: Request, res: Response): Promise<void> {
  const result = await scanService.getScan(req.params.id, req.userId);
  res.status(200).json(result);
}

export async function list(req: Request, res: Response): Promise<void> {
  const result = await scanService.listScans(req.userId);
  res.status(200).json(result);
}
