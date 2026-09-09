import test from 'node:test'
import assert from 'node:assert/strict'
import { DriftTracker, horizonBucket, horizonLabel, periodOf, HORIZON_BUCKETS } from './drift.js'
import type { TripUpdateRecord } from './observe.js'
import { DayType } from './servicedate.js'

/**
 * The drift tracker, against literals.
 *
 * The central test is `recovers a producer that slips 20 seconds on approach`: it builds a
 * feed that behaves exactly the way a BART platform sign behaves — steady countdown, then
 * a late jump in the final half minute — and asserts the model reports that jump, in the
 * right bucket, at the right size. Everything else here is a guard against the ways this
 * measurement can quietly learn nothing.
 */

const DATE = '2026-09-04' // a Friday

function update(stops: { stopId: string; departure: number }[]): TripUpdateRecord {
  return {
    tripId: 'BA:1049821',
    routeId: 'BA:Red-N',
    directionId: 0,
    stops: stops.map((s) => ({ stopId: s.stopId, departure: s.departure })),
  }
}

test('horizon buckets are fine where the effect lives and coarse where it does not', () => {
  assert.equal(horizonBucket(0), 0)
  assert.equal(horizonBucket(29), 0)
  assert.equal(horizonBucket(30), 1)
  assert.equal(horizonBucket(59), 1)
  assert.equal(horizonBucket(60), 2)
  assert.equal(horizonBucket(119), 2)
  assert.equal(horizonBucket(300), 4)
  assert.equal(horizonBucket(99999), HORIZON_BUCKETS - 1)

  // The two buckets the whole exercise is about are half a minute wide each.
  assert.equal(horizonLabel(0), '0-30s')
  assert.equal(horizonLabel(1), '30-60s')
  assert.equal(horizonLabel(6), '1200s+')
})

test('periods are three hours, so evidence accrues ten times faster than half hours', () => {
  assert.equal(periodOf(0), 0)
  assert.equal(periodOf(3 * 3600 - 1), 0)
  assert.equal(periodOf(3 * 3600), 1)
  assert.equal(periodOf(8 * 3600), 2) // the morning peak
  // Service days run past midnight; the last period absorbs the owl tail rather than
  // wrapping it onto the following morning.
  assert.equal(periodOf(29 * 3600), 9)
})

test('recovers a producer that slips 20 seconds on approach', () => {
  const tracker = new DriftTracker()
  let now = 1_757_000_000

  // The agency says the train departs at T for the whole approach, then discovers in the
  // last half minute that it is actually 20 seconds later. Exactly the BART platform-sign
  // behaviour this model exists to anticipate.
  const T = now + 600
  const schedule: [number, number][] = [
    [now, T], // 600s out
    [now + 300, T], // 300s out
    [now + 480, T], // 120s out
    [now + 555, T], // 45s out
    [now + 585, T + 20], // 35s out: the jump
    [now + 600, T + 20], // 20s out, into the closest bucket
  ]

  let samples: ReturnType<DriftTracker['ingest']> = []
  for (const [at, predicted] of schedule) {
    now = at
    samples = tracker.ingest([update([{ stopId: 'PLAT1', departure: predicted }])], now, DATE)
    assert.equal(samples.length, 0, 'emitted before the stop left the feed')
  }

  // The stop leaves the feed: the train arrived.
  samples = tracker.ingest([], now + 15, DATE)

  const byBucket = new Map(samples.map((s) => [s.horizon, s.drift]))
  // Every bucket observed before the jump should report the full 20 seconds.
  assert.equal(byBucket.get(5), 20, '600s out: the slip was not reported')
  assert.equal(byBucket.get(4), 20, '300s out')
  assert.equal(byBucket.get(3), 20, '120s out')
  assert.equal(byBucket.get(1), 20, '45s out')
  // And the bucket the final answer was made in reports nothing, by construction.
  assert.equal(byBucket.get(0), 0, '0-30s should be self-referential and flat')

  const one = samples.find((s) => s.horizon === 4)!
  assert.equal(one.agency, 'BA')
  assert.equal(one.routeId, 'BA:Red-N')
  assert.equal(one.dayType, DayType.Fri)
})

test('a stop that vanishes while still far out teaches nothing', () => {
  const tracker = new DriftTracker()
  const now = 1_757_000_000

  // Tracked from ten minutes out to five, then the producer drops it — cancelled, rerouted
  // or simply flaky. Its last prediction never converged, so counting it would teach the
  // model that this agency's estimates do not move: a bias toward zero in every bucket,
  // indistinguishable from a well-behaved producer.
  tracker.ingest([update([{ stopId: 'PLAT1', departure: now + 600 }])], now, DATE)
  tracker.ingest([update([{ stopId: 'PLAT1', departure: now + 620 }])], now + 300, DATE)
  const samples = tracker.ingest([], now + 320, DATE)

  assert.equal(samples.length, 0, 'learned from a stop that never arrived')
  assert.equal(tracker.status().abandoned, 1)
})

test('a cancelled trip is not evidence', () => {
  const tracker = new DriftTracker()
  const now = 1_757_000_000
  const cancelled: TripUpdateRecord = {
    ...update([{ stopId: 'PLAT1', departure: now + 30 }]),
    relationship: 'CANCELED',
  }

  tracker.ingest([cancelled], now, DATE)
  assert.equal(tracker.status().tracked, 0)
  assert.deepEqual(tracker.ingest([], now + 20, DATE), [])
})

test('a stop sitting in one bucket contributes one sample, not twenty', () => {
  const tracker = new DriftTracker()
  let now = 1_757_000_000
  const T = now + 400

  // Five minutes of cycles, all inside the 300-600s bucket. Counting each one would
  // inflate the evidence count without adding any evidence, and the shrinkage ladder
  // would then trust the cell far more than it has earned.
  for (let i = 0; i < 20; i++) {
    tracker.ingest([update([{ stopId: 'PLAT1', departure: T }])], now, DATE)
    now += 5
  }
  tracker.ingest([update([{ stopId: 'PLAT1', departure: T }])], T - 10, DATE)
  const samples = tracker.ingest([], T + 5, DATE)

  const inBucket4 = samples.filter((s) => s.horizon === 4)
  assert.equal(inBucket4.length, 1, `one sample per bucket, got ${inBucket4.length}`)
})

test('every agency in the feed is measured, not a configured subset', () => {
  const tracker = new DriftTracker()
  const now = 1_757_000_000
  const agencies = ['SF', 'BA', 'AC', 'VTA', 'SM', 'CT', 'GG', 'WC']

  const feed = agencies.map((a) => ({
    tripId: `${a}:trip1`,
    routeId: `${a}:route1`,
    directionId: 0,
    stops: [{ stopId: 'S1', departure: now + 100 }],
  }))
  tracker.ingest(feed, now, DATE)

  const closing = feed.map((u) => ({ ...u, stops: [{ stopId: 'S1', departure: now + 130 }] }))
  tracker.ingest(closing, now + 90, DATE)
  const samples = tracker.ingest([], now + 135, DATE)

  const seen = new Set(samples.map((s) => s.agency))
  assert.deepEqual([...seen].sort(), [...agencies].sort(), 'an agency went unmeasured')
  // The point of the exercise: this is not gated on PROFILED_AGENCIES.
  assert.ok(seen.has('AC') && seen.has('VTA'), 'unprofiled agencies must still be measured')
})

test('drift is signed so that adding it corrects the prediction', () => {
  const tracker = new DriftTracker()
  const now = 1_757_000_000
  const T = now + 200

  // A producer that runs *optimistic*: says T, arrives 30s later. Correcting a future
  // prediction means adding the drift, so the sign has to be final - atHorizon.
  tracker.ingest([update([{ stopId: 'PLAT1', departure: T }])], now, DATE)
  tracker.ingest([update([{ stopId: 'PLAT1', departure: T + 30 }])], T - 20, DATE)
  const late = tracker.ingest([], T + 35, DATE)
  assert.equal(late.find((s) => s.horizon === 3)?.drift, 30)

  // And a pessimistic one, to prove the sign is not accidental.
  const t2 = new DriftTracker()
  t2.ingest([update([{ stopId: 'PLAT1', departure: T }])], now, DATE)
  t2.ingest([update([{ stopId: 'PLAT1', departure: T - 25 }])], T - 20, DATE)
  const early = t2.ingest([], T + 5, DATE)
  assert.equal(early.find((s) => s.horizon === 3)?.drift, -25)
})
