import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  issueTokens,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from './token.service';
import { AppError } from '../middleware/error';

const USER_ID = '507f1f77bcf86cd799439011';

test('issueTokens → access token verifies back to the same user', () => {
  const { accessToken } = issueTokens(USER_ID);
  const payload = verifyAccessToken(accessToken);
  assert.equal(payload.sub, USER_ID);
  assert.equal(payload.type, 'access');
});

test('refresh token roundtrips and is typed as refresh', () => {
  const token = signRefreshToken(USER_ID);
  const payload = verifyRefreshToken(token);
  assert.equal(payload.sub, USER_ID);
  assert.equal(payload.type, 'refresh');
});

test('an access token is rejected by the refresh verifier (secret + type separation)', () => {
  const { accessToken } = issueTokens(USER_ID);
  assert.throws(() => verifyRefreshToken(accessToken), AppError);
});

test('a refresh token is rejected by the access verifier', () => {
  const token = signRefreshToken(USER_ID);
  assert.throws(() => verifyAccessToken(token), AppError);
});

test('garbage tokens throw a 401 AppError, not a raw jwt error', () => {
  try {
    verifyAccessToken('not-a-real-token');
    assert.fail('expected verifyAccessToken to throw');
  } catch (err) {
    assert.ok(err instanceof AppError);
    assert.equal(err.statusCode, 401);
    assert.equal(err.code, 'INVALID_TOKEN');
  }
});
