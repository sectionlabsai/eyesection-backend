import sharp from 'sharp';
import { AppError } from '../middleware/error';

const MAX_BYTES = 12 * 1024 * 1024; // 12mb
const THUMB_MAX_PX = 800;
const THUMB_QUALITY = 80;
const EYE_THUMB_MAX_PX = 640;

export interface ProcessedImage {
  raw: Buffer; // auto-oriented, EXIF stripped, re-encoded JPEG
  thumb: Buffer; // <=800px, quality 80, EXIF stripped
  contentType: 'image/jpeg';
}

/**
 * Validate and process an uploaded eye photo.
 *  - Rejects anything that isn't a JPEG/PNG or is >12mb.
 *  - Auto-orients via EXIF, then STRIPS EXIF (privacy) by re-encoding.
 *  - Produces a normalized full JPEG ("raw") and an <=800px thumbnail.
 *
 * Note: sharp drops metadata by default unless .withMetadata() is called, so
 * both outputs are EXIF-free. Orientation is baked in first via .rotate().
 */
export async function processEyeImage(input: Buffer): Promise<ProcessedImage> {
  if (input.length > MAX_BYTES) {
    throw new AppError(413, 'That photo is too large (max 12MB)', 'IMAGE_TOO_LARGE');
  }

  // failOn: 'none' tolerates recoverable defects (truncated/slightly-corrupt
  // JPEGs from phone cameras) instead of throwing — matches browser/native decoders.
  const opts: sharp.SharpOptions = { failOn: 'none' };

  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, opts).metadata();
  } catch {
    throw new AppError(400, "We couldn't read that image", 'IMAGE_UNREADABLE');
  }

  if (meta.format !== 'jpeg' && meta.format !== 'png') {
    throw new AppError(415, 'Please use a JPEG or PNG photo', 'IMAGE_UNSUPPORTED');
  }

  // metadata() doesn't decode pixels, so decode errors surface here. Catch them
  // as a clean 400 rather than letting a raw sharp error become an unhandled 500.
  try {
    // .rotate() with no arg applies EXIF orientation, then output re-encode strips EXIF.
    const raw = await sharp(input, opts).rotate().jpeg({ quality: 92 }).toBuffer();

    const thumb = await sharp(input, opts)
      .rotate()
      .resize({ width: THUMB_MAX_PX, height: THUMB_MAX_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: THUMB_QUALITY })
      .toBuffer();

    return { raw, thumb, contentType: 'image/jpeg' };
  } catch {
    throw new AppError(400, "We couldn't read that image", 'IMAGE_UNREADABLE');
  }
}

/**
 * Downscale an already-decoded JPEG (e.g. the eye-region crop) into a compact,
 * display-ready thumbnail. Best-effort: returns null if the buffer can't be
 * re-encoded, so callers can skip persisting a thumbnail rather than fail.
 */
export async function makeDisplayThumb(input: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(input, { failOn: 'none' })
      .resize({
        width: EYE_THUMB_MAX_PX,
        height: EYE_THUMB_MAX_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: THUMB_QUALITY })
      .toBuffer();
  } catch {
    return null;
  }
}
