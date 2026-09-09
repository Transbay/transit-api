import test from 'node:test'
import assert from 'node:assert/strict'
import { ScheduleIndex, type TripSchedule } from './schedule.js'
import {
  TripTracker,
  Tier,
  HORIZONS,
  tierWeight,
  fingerprintOf,
  type FeedCycle,
  type TripUpdateRecord,
  type VehicleRecord,
} from './observe.js'

const T0 = 1_760_000_000
const TRIP = 'SF:5001'
const ROUTE = 'SF:14'

/**
 * A five-stop trip whose segments are deliberately uneven: 60s, 240s, 60s, 60s. The
 * unevenness is the point — an interpolation that split a window evenly would pass every
 * test built on equal segments and be wrong on the real network.
 */
function schedule(): ScheduleIndex {
  const runs = [60, 240, 60, 60]
  const stops = [{ stopId: 'SF:1', seq: 1, arrival: 0, departure: 0, timepoint: true }]
  let t = 0
  for (let i = 0; i < runs.length; i++) {
    t += runs[i]
    stops.push({
      stopId: `SF:${i + 2}`,
      seq: i + 2,
      arrival: t,
      departure: t + 10,
      timepoint: false,
    })
    t += 10
  }
  const trip: TripSchedule = {
    agency: 'SF',
    tripId: TRIP,
    routeId: ROUTE,
    directionId: 0,
    patternId: 'p1',
    serviceId: 'wk',
    blockId: 'b1',
    shortName: '',
    stops,
  }
  return new ScheduleIndex([trip])
}

function tracker(opts: Partial<ConstructorParameters<typeof TripTracker>[0]> = {}) {
  return new TripTracker({ profiled: new Set(['SF']), ...opts })
}

/** Trip update listing the stops from `firstSeq` onward, each predicted `+offset`. */
function update(firstSeq: number, at: number, offset = 0, extra: Partial<TripUpdateRecord> = {}): TripUpdateRecord {
  const stops = []
  for (let seq = firstSeq; seq <= 5; seq++) {
    stops.push({ stopId: `SF:${seq}`, seq, departure: at + (seq - firstSeq) * 120 + offset })
  }
  return { tripId: TRIP, routeId: ROUTE, stops, ...extra }
}

function vehicle(seq: number, status: VehicleRecord['currentStatus'], at: number): VehicleRecord {
  return { vehicleId: '5501', tripId: TRIP, currentStopSequence: seq, currentStatus: status, timestamp: at }
}

function cycle(at: number, updates: TripUpdateRecord[], vehicles: VehicleRecord[] = []): FeedCycle {
  return { at, updates, vehicles }
}

const onDate = () => '2026-09-08'

// ---------------------------------------------------------------------------
// Position-derived observation
// ---------------------------------------------------------------------------

test('a vehicle seen stopped and then moving gives arrival, departure and a dwell', () => {
  const t = tracker()
  const s = schedule()

  t.ingest(cycle(T0, [update(2, T0)], [vehicle(2, 'STOPPED_AT', T0)]), s, onDate)
  t.ingest(cycle(T0 + 15, [update(2, T0 + 15)], [vehicle(2, 'STOPPED_AT', T0 + 15)]), s, onDate)
  const events = t.ingest(
    cycle(T0 + 30, [update(3, T0 + 30)], [vehicle(3, 'IN_TRANSIT_TO', T0 + 30)]),
    s,
    onDate,
  )

  const e = events.find((x) => x.seq === 2)
  assert.ok(e, 'expected an event for the stop just left')
  assert.equal(e.tier, Tier.A1)
  assert.equal(e.composite, false, 'A1 is the only tier that can separate arrival from departure')
  assert.equal(e.arrival, T0, 'arrival is the first sighting of STOPPED_AT')
  assert.ok(e.departure! > e.arrival!, 'a dwell, not an instant')
  assert.equal(e.stopId, 'SF:2')
})

test('a vehicle that is never seen stopped gives a composite time, not a fake dwell', () => {
  const t = tracker()
  const s = schedule()

  t.ingest(cycle(T0, [update(2, T0)], [vehicle(2, 'IN_TRANSIT_TO', T0)]), s, onDate)
  const events = t.ingest(
    cycle(T0 + 30, [update(3, T0 + 30)], [vehicle(3, 'IN_TRANSIT_TO', T0 + 30)]),
    s,
    onDate,
  )

  const e = events.find((x) => x.seq === 2)!
  assert.equal(e.tier, Tier.A2)
  assert.equal(e.composite, true)
  assert.equal(e.arrival, undefined, 'we did not see an arrival, so we must not invent one')
  assert.ok(e.departure! >= T0 && e.departure! <= T0 + 30)
})

test('a skipped-over stop is placed by scheduled running time, not by splitting evenly', () => {
  const t = tracker()
  const s = schedule()

  t.ingest(cycle(T0, [update(2, T0)], [vehicle(2, 'IN_TRANSIT_TO', T0)]), s, onDate)
  // 300 seconds later the vehicle is at stop 4, so stop 3 was passed somewhere inside.
  const events = t.ingest(
    cycle(T0 + 300, [update(4, T0 + 300)], [vehicle(4, 'IN_TRANSIT_TO', T0 + 300)]),
    s,
    onDate,
  )

  const mid = events.find((x) => x.seq === 3)!
  assert.equal(mid.tier, Tier.B)
  // Stop 2 -> 3 is the long leg (240s of a 310s scheduled span) and 3 -> 4 is the short
  // one, so stop 3 is crossed *late* in the window -- around 77% of the way through. An
  // even split would have put it at +150, which is 80 seconds wrong on a five-minute
  // window and would be wrong in the same direction on every express segment in the city.
  assert.ok(mid.departure! > T0 + 200, `expected a late crossing, got +${mid.departure! - T0}`)
  assert.ok(Math.abs(mid.departure! - (T0 + 232)) <= 2, `got +${mid.departure! - T0}`)
  assert.ok(mid.sigma > 35, 'interpolation is less certain than a direct sighting')
})

test('a sequence jump too wide to trust is refused rather than interpolated', () => {
  const t = tracker({ maxGap: 2 })
  const s = schedule()

  t.ingest(cycle(T0, [update(1, T0)], [vehicle(1, 'IN_TRANSIT_TO', T0)]), s, onDate)
  const events = t.ingest(
    cycle(T0 + 60, [update(5, T0 + 60)], [vehicle(5, 'IN_TRANSIT_TO', T0 + 60)]),
    s,
    onDate,
  )

  assert.equal(events.filter((e) => e.tier === Tier.B).length, 0)
  assert.equal(t.stats.gapsTooWide, 1)
})

test('an absent current_status produces no position events at all', () => {
  // The protobuf default for VehicleStopStatus is IN_TRANSIT_TO, so a producer that never
  // sets the field decodes as a vehicle that is permanently in transit. Reading that as
  // real would mint tier-A observations for an entire agency out of nothing.
  const t = tracker()
  const s = schedule()
  const noStatus: VehicleRecord = { vehicleId: '5501', tripId: TRIP, currentStopSequence: 2 }

  t.ingest(cycle(T0, [update(2, T0)], [noStatus]), s, onDate)
  const events = t.ingest(
    cycle(T0 + 30, [update(3, T0 + 30)], [{ ...noStatus, currentStopSequence: 3 }]),
    s,
    onDate,
  )

  assert.equal(events.filter((e) => e.tier === Tier.A1 || e.tier === Tier.A2).length, 0)
})

test('a stale position is not evidence of a transition', () => {
  const t = tracker({ staleVehicleSeconds: 120 })
  const s = schedule()

  t.ingest(cycle(T0, [update(2, T0)], [vehicle(2, 'STOPPED_AT', T0)]), s, onDate)
  const events = t.ingest(
    // The vehicle's own timestamp is ten minutes old; the fetch is current.
    cycle(T0 + 30, [update(3, T0 + 30)], [vehicle(3, 'IN_TRANSIT_TO', T0 - 600)]),
    s,
    onDate,
  )

  assert.equal(events.filter((e) => e.tier <= Tier.B).length, 0)
  assert.ok(t.stats.staleVehicles >= 1)
})

// ---------------------------------------------------------------------------
// Disappearance
// ---------------------------------------------------------------------------

test('a stop that leaves the list while later stops remain is a passage', () => {
  const t = tracker()
  const s = schedule()

  t.ingest(cycle(T0, [update(2, T0)]), s, onDate)
  const events = t.ingest(cycle(T0 + 60, [update(3, T0 + 60)]), s, onDate)

  const e = events.find((x) => x.seq === 2)!
  assert.equal(e.tier, Tier.Cu, 'uncalibrated agencies get the wider tier')
  assert.equal(e.composite, true)
  assert.equal(e.departure, T0, 'the last thing the feed said before it went quiet')
})

test('a calibrated agency gets the narrower tier for the same evidence', () => {
  const t = tracker({ calibrated: new Set(['SF']) })
  const s = schedule()
  t.ingest(cycle(T0, [update(2, T0)]), s, onDate)
  const events = t.ingest(cycle(T0 + 60, [update(3, T0 + 60)]), s, onDate)
  assert.equal(events.find((x) => x.seq === 2)!.tier, Tier.C)
})

test('a skipped stop leaving the list is not a passage', () => {
  const t = tracker()
  const s = schedule()

  const skipped = update(2, T0)
  skipped.stops[0].relationship = 'SKIPPED'
  t.ingest(cycle(T0, [skipped]), s, onDate)
  const events = t.ingest(cycle(T0 + 60, [update(3, T0 + 60)]), s, onDate)

  assert.equal(events.filter((e) => e.seq === 2).length, 0)
  assert.equal(t.stats.skippedStops, 1)
})

test('a truncated trip is not a fleet of passages', () => {
  // Every stop vanishes at once, which is a producer dropping the trip, not a bus
  // teleporting to the terminal.
  const t = tracker()
  const s = schedule()

  t.ingest(cycle(T0, [update(2, T0)]), s, onDate)
  const events = t.ingest(cycle(T0 + 60, [{ tripId: TRIP, routeId: ROUTE, stops: [] }]), s, onDate)

  assert.equal(events.length, 0)
})

test('a stop is observed once, however it is observed', () => {
  const t = tracker()
  const s = schedule()

  t.ingest(cycle(T0, [update(2, T0)], [vehicle(2, 'STOPPED_AT', T0)]), s, onDate)
  const first = t.ingest(
    cycle(T0 + 30, [update(3, T0 + 30)], [vehicle(3, 'IN_TRANSIT_TO', T0 + 30)]),
    s,
    onDate,
  )
  const second = t.ingest(
    cycle(T0 + 60, [update(4, T0 + 60)], [vehicle(4, 'IN_TRANSIT_TO', T0 + 60)]),
    s,
    onDate,
  )

  assert.equal(first.filter((e) => e.seq === 2).length, 1)
  assert.equal(second.filter((e) => e.seq === 2).length, 0, 'no second sighting of stop 2')
})

// ---------------------------------------------------------------------------
// Producer failures
// ---------------------------------------------------------------------------

test('a frozen producer emits nothing rather than a cycle of fake convergence', () => {
  const t = tracker()
  const s = schedule()
  // Enough trips that "nothing moved in fifteen seconds" really is impossible.
  const frozen = () =>
    [0, 1, 2, 3, 4, 5].map((i) => ({ ...update(2, T0), tripId: `SF:600${i}` }))

  t.ingest(cycle(T0, frozen()), s, onDate)
  const again = t.ingest(cycle(T0 + 15, frozen()), s, onDate)
  const third = t.ingest(cycle(T0 + 30, frozen()), s, onDate)

  assert.equal(again.length, 0)
  assert.equal(third.length, 0)
  assert.equal(t.stats.frozenAgencies, 2)
})

test('a quiet overnight producer is not mistaken for a frozen one', () => {
  // Two trips out at 3 a.m. whose predictions genuinely did not move. Suppressing these
  // would blind the profile to exactly the hours that are hardest to collect.
  const t = tracker()
  const s = schedule()

  t.ingest(cycle(T0, [update(2, T0)]), s, onDate)
  const events = t.ingest(cycle(T0 + 15, [update(3, T0)]), s, onDate)

  assert.equal(t.stats.frozenAgencies, 0)
  assert.equal(events.filter((e) => e.seq === 2).length, 1)
})

test('two entities for one trip are noticed rather than silently halving its history', () => {
  const t = tracker()
  const s = schedule()
  t.ingest(cycle(T0, [update(2, T0), update(2, T0, 5)]), s, onDate)
  assert.equal(t.stats.duplicateEntities, 1)
})

test('a cancelled trip is dropped, not closed out as a series of passages', () => {
  const t = tracker()
  const s = schedule()

  t.ingest(cycle(T0, [update(2, T0)]), s, onDate)
  const events = t.ingest(
    cycle(T0 + 15, [{ tripId: TRIP, routeId: ROUTE, relationship: 'CANCELED', stops: [] }]),
    s,
    onDate,
  )

  assert.equal(events.length, 0)
  assert.equal(t.activeTrips, 0)
})

test('an unprofiled agency is ignored entirely', () => {
  const t = tracker({ profiled: new Set(['BA']) })
  const s = schedule()
  assert.equal(t.ingest(cycle(T0, [update(2, T0)]), s, onDate).length, 0)
  assert.equal(t.activeTrips, 0)
})

test('a trip whose service date cannot be resolved produces nothing', () => {
  const t = tracker()
  const s = schedule()
  assert.equal(t.ingest(cycle(T0, [update(2, T0)]), s, () => null).length, 0)
  assert.equal(t.stats.unmatchedTrips, 1)
})

// ---------------------------------------------------------------------------
// Prediction sampling
// ---------------------------------------------------------------------------

test('each horizon is sampled once, as the prediction crosses it', () => {
  const t = tracker()
  const s = schedule()

  // One stop, predicted at a fixed moment, watched as the clock closes in on it.
  const eventAt = T0 + 2000
  const one = (at: number): TripUpdateRecord => ({
    tripId: TRIP,
    routeId: ROUTE,
    stops: [
      { stopId: 'SF:2', seq: 2, departure: eventAt },
      { stopId: 'SF:3', seq: 3, departure: eventAt + 300 },
    ],
  })

  for (let at = T0; at < eventAt; at += 30) t.ingest(cycle(at, [one(at)]), s, onDate)
  const events = t.ingest(
    cycle(eventAt, [{ tripId: TRIP, routeId: ROUTE, stops: [{ stopId: 'SF:3', seq: 3, departure: eventAt + 300 }] }]),
    s,
    onDate,
  )

  const e = events.find((x) => x.seq === 2)!
  const horizons = e.predictions.map((p) => p.horizon)
  assert.deepEqual(horizons, [...HORIZONS], 'every horizon, in order, exactly once')
  for (const p of e.predictions) assert.equal(p.predicted, eventAt)
})

test('a horizon already passed when we first see a trip is not back-filled', () => {
  const t = tracker()
  const s = schedule()
  const eventAt = T0 + 100

  t.ingest(
    cycle(T0, [{ tripId: TRIP, routeId: ROUTE, stops: [
      { stopId: 'SF:2', seq: 2, departure: eventAt },
      { stopId: 'SF:3', seq: 3, departure: eventAt + 300 },
    ] }]),
    s,
    onDate,
  )
  const events = t.ingest(
    cycle(eventAt, [{ tripId: TRIP, routeId: ROUTE, stops: [{ stopId: 'SF:3', seq: 3, departure: eventAt + 300 }] }]),
    s,
    onDate,
  )

  const e = events.find((x) => x.seq === 2)!
  // Seen first at a 100-second horizon, so the 120-second bucket is the only one anybody
  // watched. Claiming the seven coarser ones would credit the agency's predictor with
  // half an hour of accuracy we never observed.
  assert.deepEqual(e.predictions.map((p) => p.horizon), [120])
  assert.equal(e.predictions[0].predicted, eventAt)
})

// ---------------------------------------------------------------------------
// Weighting
// ---------------------------------------------------------------------------

test('tier weights make a guess count for a fraction of a sighting', () => {
  assert.equal(tierWeight(Tier.A1), 1)
  assert.ok(tierWeight(Tier.C) < 0.1)
  assert.ok(tierWeight(Tier.Cu) < tierWeight(Tier.C) / 3)
})

test('the fingerprint moves when predictions move, not just when trips change', () => {
  const a = update(2, T0)
  const b = update(2, T0, 30)
  assert.notEqual(fingerprintOf([a]), fingerprintOf([b]))
  assert.equal(fingerprintOf([a]), fingerprintOf([structuredClone(a)]))
})
