import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeDeviation, decodeDeviation, type Deviation } from './deviation.js'

/**
 * The wire format between the poller and the learner.
 *
 * These exist because of a specific bug: `Deviation` carried a nested `segment` object that
 * the encoder simply did not mention, so every observation reached the learner with no
 * segment and was rejected as having no schedule. Nothing threw, nothing logged an error,
 * and the integration test passed because it handed the learner in-memory objects instead
 * of pushing them through the stream. The service would have run for weeks learning nothing.
 *
 * So: every field a consumer reads is asserted to survive the round trip, by name.
 */

const sample: Deviation = {
  agency: 'SM',
  tripId: 'SM:1234',
  routeId: 'SM:172',
  directionId: 1,
  patternId: 'abc123',
  blockId: 'B7',
  vehicleId: '850',
  serviceDate: '2026-09-04',
  stopId: 'SM:473230',
  seq: 52,
  scheduledArrival: 1_788_000_000,
  scheduledDeparture: 1_788_000_030,
  actualArrival: 1_788_000_010,
  actualDeparture: 1_788_000_055,
  devArrival: -20,
  devDeparture: 25,
  priorDev: -95,
  delta: 120,
  dwell: 45,
  segmentKey: 'SM|SM:172|1|SM:473229>SM:473230',
  corridorKey: 'SM:473229>SM:473230',
  tripStart: false,
  scheduledRun: 180,
  bucket: 16,
  dayType: 2,
  timepoint: true,
  held: true,
  tier: 1,
  sigma: 15,
  composite: false,
  predictions: [
    { horizon: 600, predicted: 1_788_000_100 },
    { horizon: 300, predicted: 1_788_000_060 },
  ],
}

test('every field survives the stream', () => {
  const back = decodeDeviation(encodeDeviation(sample))
  assert.deepEqual(back, sample)
})

test('no field is silently dropped', () => {
  // deepEqual above would pass if a field were absent from *both* sides, so the key set is
  // checked against the type's own shape as well.
  const back = decodeDeviation(encodeDeviation(sample)) as unknown as Record<string, unknown>
  for (const key of Object.keys(sample)) {
    assert.ok(key in back, `${key} did not survive the round trip`)
  }
})

test('the fields the learner gates on are present and correct', () => {
  // These four decide whether an observation trains anything at all. A drop in any of them
  // is invisible: the learner rejects the row and increments a counter nobody is watching.
  const back = decodeDeviation(encodeDeviation(sample))
  assert.equal(back.segmentKey, sample.segmentKey)
  assert.equal(back.corridorKey, sample.corridorKey)
  assert.equal(back.delta, sample.delta)
  assert.equal(back.scheduledRun, sample.scheduledRun)
})

test('absent optionals stay absent rather than becoming zero', () => {
  const sparse: Deviation = {
    ...sample,
    vehicleId: undefined,
    actualArrival: undefined,
    devArrival: undefined,
    priorDev: undefined,
    delta: undefined,
    dwell: undefined,
    segmentKey: undefined,
    corridorKey: undefined,
    tripStart: true,
    predictions: [],
  }
  const back = decodeDeviation(encodeDeviation(sparse))
  assert.equal(back.priorDev, undefined, 'a missing prior deviation is not a prior of zero')
  assert.equal(back.delta, undefined)
  assert.equal(back.segmentKey, undefined)
  assert.equal(back.tripStart, true)
  assert.deepEqual(back.predictions, [])
})

test('a JSON round trip through Redis changes nothing', () => {
  // The stream stores the encoded object as a JSON string, so that hop is part of the path.
  const wire = JSON.parse(JSON.stringify(encodeDeviation(sample)))
  assert.deepEqual(decodeDeviation(wire), sample)
})
