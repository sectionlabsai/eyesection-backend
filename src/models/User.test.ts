import { test } from 'node:test';
import assert from 'node:assert/strict';
import { User } from './User';

// validateSync runs the schema validators offline (no DB connection needed),
// so these guard the EB-13 anonymous-first schema changes in the CI suite.

test('anonymous users validate without an email', () => {
  const u = new User({ authProvider: 'anonymous', isAnonymous: true });
  assert.equal(u.validateSync(), undefined);
});

test('non-anonymous users still require an email', () => {
  const u = new User({ authProvider: 'email', isAnonymous: false });
  const err = u.validateSync();
  assert.ok(err, 'expected a validation error');
  assert.ok(err.errors.email, 'expected email to be required');
});

test('careProducts defaults to an empty array', () => {
  const u = new User({ authProvider: 'anonymous', isAnonymous: true });
  assert.deepEqual(u.careProducts, []);
});
