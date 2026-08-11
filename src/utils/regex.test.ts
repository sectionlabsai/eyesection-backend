import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeRegex } from './regex';

test('escapeRegex escapes every regex metacharacter', () => {
  assert.equal(escapeRegex('.*+?^${}()|[]\\'), '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
});

test('escapeRegex leaves an ordinary email fragment untouched', () => {
  assert.equal(escapeRegex('care@skinsection'), 'care@skinsection');
});

test('escaped input matches only its literal, neutralising injection', () => {
  // `.*` as a literal must NOT match an arbitrary email.
  const re = new RegExp(escapeRegex('.*'), 'i');
  assert.equal(re.test('someone@example.com'), false);
  assert.equal(re.test('a.*b'), true);
});

test('escaped catastrophic-backtracking input stays a linear literal match', () => {
  // Unescaped, `(a+)+$` is a classic ReDoS pattern; escaped it is just text.
  const re = new RegExp(escapeRegex('(a+)+$'), 'i');
  assert.equal(re.test('aaaaaaaaaaaaaaaaaaaaaaaa!'), false);
  assert.equal(re.test('x(a+)+$y'), true);
});
