import test from 'node:test'
import assert from 'node:assert/strict'
import { decide, horizonBucket } from './accuracyrules.js'

const now = 1_800_000_000

test('a trip still listed is only updated', () => {
  assert.equal(decide({ at: now - 600, last: now + 60, seenAt: now - 30 }, now + 90, now), 'seen')
})

test('gone, and due when last seen a moment ago: it departed', () => {
  assert.equal(decide({ at: now - 600, last: now - 10, seenAt: now - 30 }, undefined, now), 'departed')
  // Due within two minutes of the last sighting still counts; the index lags the vehicle.
  assert.equal(decide({ at: now - 600, last: now + 80, seenAt: now - 30 }, undefined, now), 'departed')
})

test('gone while still minutes away is not a departure', () => {
  const p = { at: now - 600, last: now + 900, seenAt: now - 30 }
  assert.equal(decide(p, undefined, now), 'wait', 'a brief gap must not resolve the check')
  assert.equal(decide({ ...p, seenAt: now - 601 }, undefined, now), 'vanished')
})

test('a stale last sighting is never scored as the actual', () => {
  // Due when last seen, but that was five minutes ago: when it left is unknown.
  assert.notEqual(decide({ at: now - 900, last: now - 300, seenAt: now - 300 }, undefined, now), 'departed')
})

test('horizon buckets put ten minutes in its own row', () => {
  assert.equal(horizonBucket(299), 5)
  assert.equal(horizonBucket(600), 10)
  assert.equal(horizonBucket(601), 15)
  assert.equal(horizonBucket(1500), 30)
})
