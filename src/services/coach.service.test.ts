import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Types } from 'mongoose';
import { activeHoursSchema, updateSchema } from '../controllers/coach.controller';
import { BreakPlan } from '../models/BreakPlan';
import { toLocalReminders } from './coach.service';

test('serializes enabled reminders with interval and fixed time metadata', () => {
  const plan = new BreakPlan({
    userId: new Types.ObjectId(),
    template: 'gamer',
    activeHours: { start: '13:00', end: '23:30' },
    active: true,
    reminders: [
      { type: '2020', intervalMin: 30, enabled: true },
      { type: 'blink', intervalMin: 20, enabled: false },
      { type: 'hydrate', intervalMin: 45, enabled: true },
      { type: 'winddown', atTime: '23:15', enabled: true },
    ],
  });

  assert.deepEqual(toLocalReminders(plan), {
    activeHours: { start: '13:00', end: '23:30' },
    active: true,
    reminders: [
      { type: '2020', intervalMin: 30, enabled: true },
      { type: 'hydrate', intervalMin: 45, enabled: true },
      { type: 'winddown', atTime: '23:15', enabled: true },
    ],
  });
});

test('rejects empty and overnight active-hour windows', () => {
  assert.equal(
    activeHoursSchema.safeParse({ start: '09:00', end: '09:00' }).success,
    false,
  );
  assert.equal(
    activeHoursSchema.safeParse({ start: '22:00', end: '06:00' }).success,
    false,
  );
  assert.equal(
    activeHoursSchema.safeParse({ start: '06:00', end: '23:59' }).success,
    true,
  );
  assert.equal(
    activeHoursSchema.safeParse({ start: '06:00', end: '24:00' }).success,
    true,
  );
});

test('uses the same 5-120 minute interval contract as Flutter', () => {
  const patch = (intervalMin: number) => ({
    reminders: [{ type: '2020' as const, intervalMin }],
  });
  assert.equal(updateSchema.safeParse(patch(5)).success, true);
  assert.equal(updateSchema.safeParse(patch(120)).success, true);
  assert.equal(updateSchema.safeParse(patch(4)).success, false);
  assert.equal(updateSchema.safeParse(patch(121)).success, false);
});

test('enforces one break plan per user at the schema level', () => {
  const userId = BreakPlan.schema.path('userId');
  assert.equal(userId.options.unique, true);
});
