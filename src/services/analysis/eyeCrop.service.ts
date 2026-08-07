import sharp from 'sharp';
import { logger } from '../../utils/logger';
import { Rect, ScanGeometry } from './types';

/**
 * Builds the close-up eye-region JPEG sent to the vision model (EB-05).
 * The full photo at low detail loses the eye area almost entirely once the
 * provider downscales it, so we crop the region the geometry already located
 * and send that at high detail instead.
 */

const CROP_MAX_PX = 1024;
const CROP_QUALITY = 90;

/** Union of the available eye-area rects, padded to include lids, brows and the top of the cheek. */
function eyeRegionRect(geometry: ScanGeometry): Rect | null {
  const crops = geometry.crops ?? {};
  const parts = [crops.irisLeft, crops.irisRight, crops.underEye].filter(
    (r): r is Rect => !!r,
  );
  if (parts.length === 0) return null;

  let x1 = Math.min(...parts.map((r) => r.x));
  let y1 = Math.min(...parts.map((r) => r.y));
  let x2 = Math.max(...parts.map((r) => r.x + r.width));
  let y2 = Math.max(...parts.map((r) => r.y + r.height));

  // A touch more context around the eyes (brows / outer canthi / upper cheek)
  // so the crop doesn't feel glued to the lids.
  const padX = (x2 - x1) * 0.35;
  const padY = (y2 - y1) * 0.6;
  x1 = Math.max(0, x1 - padX);
  y1 = Math.max(0, y1 - padY);
  x2 = Math.min(1, x2 + padX);
  y2 = Math.min(1, y2 + padY);

  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Extract the eye region as a JPEG buffer, or null when the geometry has no
 * crops or extraction fails (callers then fall back to the full photo).
 */
export async function extractEyeRegionJpeg(
  imageBuffer: Buffer,
  geometry: ScanGeometry,
): Promise<Buffer | null> {
  const rect = eyeRegionRect(geometry);
  if (!rect) return null;

  try {
    const image = sharp(imageBuffer);
    const meta = await image.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) return null;

    const left = Math.round(rect.x * width);
    const top = Math.round(rect.y * height);
    const w = Math.max(1, Math.min(Math.round(rect.width * width), width - left));
    const h = Math.max(1, Math.min(Math.round(rect.height * height), height - top));

    return await image
      .extract({ left, top, width: w, height: h })
      .resize({ width: CROP_MAX_PX, withoutEnlargement: true })
      .jpeg({ quality: CROP_QUALITY })
      .toBuffer();
  } catch (err) {
    logger.warn('Eye-region crop failed — falling back to the full photo', err);
    return null;
  }
}
