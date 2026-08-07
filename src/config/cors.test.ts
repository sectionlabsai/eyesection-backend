import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCorsOptions } from './cors';

type OriginFn = (
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
) => void;

/** Resolve the cors `origin` callback synchronously for assertions. */
function isAllowed(origin: string | undefined): boolean {
  const opts = buildCorsOptions();
  assert.equal(typeof opts.origin, 'function');
  let allowed = false;
  (opts.origin as OriginFn)(origin, (_err, allow) => {
    allowed = !!allow;
  });
  return allowed;
}

// setup.ts configures CORS_ORIGINS=https://admin.eyesection.com → strict branch.

test('requests with no Origin header (native mobile / server-to-server) are allowed', () => {
  assert.equal(isAllowed(undefined), true);
});

test('an allowlisted browser origin is allowed', () => {
  assert.equal(isAllowed('https://admin.eyesection.com'), true);
});

test('a non-allowlisted browser origin is blocked', () => {
  assert.equal(isAllowed('https://evil.example.com'), false);
});
