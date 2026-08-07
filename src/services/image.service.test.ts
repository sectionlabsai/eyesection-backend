import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { processEyeImage } from './image.service';
import { AppError } from '../middleware/error';

test('processEyeImage produces a normalized JPEG + thumbnail from a valid PNG', async () => {
  const png = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 120, b: 90 } },
  })
    .png()
    .toBuffer();

  const out = await processEyeImage(png);
  assert.equal(out.contentType, 'image/jpeg');
  assert.ok(out.raw.length > 0);
  assert.ok(out.thumb.length > 0);

  // Both outputs must be re-encoded JPEGs (EXIF stripped on re-encode).
  const rawMeta = await sharp(out.raw).metadata();
  const thumbMeta = await sharp(out.thumb).metadata();
  assert.equal(rawMeta.format, 'jpeg');
  assert.equal(thumbMeta.format, 'jpeg');
  assert.ok((thumbMeta.width ?? 0) <= 800 && (thumbMeta.height ?? 0) <= 800);
});

test('processEyeImage rejects an oversized image with 413 IMAGE_TOO_LARGE', async () => {
  const tooBig = Buffer.alloc(12 * 1024 * 1024 + 1);
  await assert.rejects(processEyeImage(tooBig), (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.statusCode, 413);
    assert.equal(err.code, 'IMAGE_TOO_LARGE');
    return true;
  });
});

test('processEyeImage rejects unreadable bytes with 400 IMAGE_UNREADABLE', async () => {
  const garbage = Buffer.from('this is definitely not an image');
  await assert.rejects(processEyeImage(garbage), (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'IMAGE_UNREADABLE');
    return true;
  });
});
