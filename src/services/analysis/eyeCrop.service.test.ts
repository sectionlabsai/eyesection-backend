import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { extractEyeRegionJpeg } from './eyeCrop.service';

async function testPhoto(): Promise<Buffer> {
  return sharp({
    create: { width: 400, height: 300, channels: 3, background: { r: 180, g: 140, b: 120 } },
  })
    .jpeg()
    .toBuffer();
}

test('extractEyeRegionJpeg crops the padded union of the eye rects', async () => {
  const photo = await testPhoto();
  const out = await extractEyeRegionJpeg(photo, {
    crops: {
      irisLeft: { x: 0.3, y: 0.4, width: 0.08, height: 0.08 },
      irisRight: { x: 0.6, y: 0.4, width: 0.08, height: 0.08 },
      underEye: { x: 0.3, y: 0.5, width: 0.38, height: 0.1 },
    },
  });

  assert.ok(out);
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'jpeg');
  // Crop must be a strict sub-region of the photo, not the whole frame.
  assert.ok((meta.width ?? 0) < 400 && (meta.width ?? 0) > 0);
  assert.ok((meta.height ?? 0) < 300 && (meta.height ?? 0) > 0);
});

test('extractEyeRegionJpeg returns null when the geometry has no crops', async () => {
  const photo = await testPhoto();
  assert.equal(await extractEyeRegionJpeg(photo, {}), null);
  assert.equal(await extractEyeRegionJpeg(photo, { eyeOpennessL: 0.3 }), null);
});

test('extractEyeRegionJpeg returns null for unreadable image bytes', async () => {
  const out = await extractEyeRegionJpeg(Buffer.from('not an image'), {
    crops: { underEye: { x: 0.3, y: 0.5, width: 0.4, height: 0.1 } },
  });
  assert.equal(out, null);
});
