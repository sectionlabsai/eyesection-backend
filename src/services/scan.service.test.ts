import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBase64Image } from './scan.service';
import { AppError } from '../middleware/error';

test('decodeBase64Image decodes plain base64 to the original bytes', () => {
  const original = Buffer.from('hello-eye-scan');
  const decoded = decodeBase64Image(original.toString('base64'));
  assert.ok(decoded.equals(original));
});

test('decodeBase64Image strips a data-URL prefix before decoding', () => {
  const original = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11]);
  const dataUrl = `data:image/jpeg;base64,${original.toString('base64')}`;
  const decoded = decodeBase64Image(dataUrl);
  assert.ok(decoded.equals(original));
});

test('decodeBase64Image rejects empty input with a 400 AppError', () => {
  try {
    decodeBase64Image('');
    assert.fail('expected decodeBase64Image to throw');
  } catch (err) {
    assert.ok(err instanceof AppError);
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'IMAGE_INVALID');
  }
});
