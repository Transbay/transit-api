import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldReload } from './schedule.js'

/**
 * These pin the rule that a new nightly feed version reloads the index mid-day.
 *
 * The bug they exist for was silent and cost a whole day of correctly-typed data: the index
 * reloaded only when the calendar date changed, so the 03:20 build was ignored until the next
 * restart -- and because the holiday map is rebuilt only on reload, and `isHoliday` needs
 * `service_day` rows that arrive with that build, Labor Day 2026 was filed as an ordinary
 * Monday for sixteen hours.
 */

const base = {
  force: false,
  loadedFor: '2026-09-07',
  today: '2026-09-07',
  loadedVersions: '2,1',
  versions: '2,1',
  size: 10399,
}

test('a warm index for today on the same feed versions is left alone', () => {
  assert.equal(shouldReload(base), false)
})

test('the date changing reloads', () => {
  assert.equal(shouldReload({ ...base, today: '2026-09-08' }), true)
})

test('a new feed version reloads even though the date has not changed', () => {
  // The nightly build at 03:20 lands version 3. Without this the index -- and the holiday
  // map with it -- stays on yesterday's answer until the process restarts.
  assert.equal(shouldReload({ ...base, versions: '3,2,1' }), true)
})

test('an empty index always reloads, so a failed first load retries', () => {
  assert.equal(shouldReload({ ...base, size: 0 }), true)
})

test('force wins over every other consideration', () => {
  assert.equal(shouldReload({ ...base, force: true }), true)
})

test('an unreadable version list does not cause a reload on its own', () => {
  // refresh() keeps the previous value when activeFeedVersions() throws, so the two match
  // and nothing is dropped just because Postgres blinked.
  assert.equal(shouldReload({ ...base, versions: base.loadedVersions }), false)
})

test('never loaded reloads', () => {
  assert.equal(shouldReload({ ...base, loadedFor: null, size: 0 }), true)
})
