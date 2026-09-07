import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fuse,
  disagreement,
  propagate,
  predict,
  correctionCap,
  temper,
  confidenceOf,
  SEGMENT_CORRELATION,
  type Estimator,
} from './predict.js'
import { Level, noEstimate, type Estimate } from './profile.js'
import {
  updateBlock,
  blockProjection,
  blockConfidence,
  absorbLayover,
  bunching,
  emptyBlockState,
  MAX_BLOCK_SECONDS,
  RUN_BREAK_SECONDS,
} from './blockstate.js'
import { epochSecondsFor } from './servicedate.js'
import { timepointsAreInformative, holdsAt, type TripSchedule } from './schedule.js'
import {
  holdOpportunity,
  holdEvidence,
  shouldHold,
  MIN_HOLD_EVIDENCE,
  type Deviation,
} from './deviation.js'

const DATE = '2026-09-04' // a Friday
const T0 = epochSecondsFor(DATE, 8 * 3600)

/** A twelve-stop route with two-minute hops, timepoints at stops 1, 6 and 12. */
function trip(timepoints = [0, 5, 11]): TripSchedule {
  const stops = []
  for (let i = 0; i < 12; i++) {
    const t = 8 * 3600 + i * 120
    stops.push({
      stopId: `SM:${100 + i}`,
      seq: i + 1,
      arrival: t,
      departure: t,
      timepoint: timepoints.includes(i),
    })
  }
  return {
    agency: 'SM',
    tripId: 'SM:9001',
    routeId: 'SM:172',
    directionId: 0,
    patternId: 'p',
    serviceId: 'wk',
    blockId: 'B12',
    shortName: '',
    stops,
  }
}

function flatProfile(
  deltaPerSegment: number,
  n = 100,
  level = Level.SegmentDayBucket,
  hold?: { rate: number; n: number },
) {
  return (): Estimate => ({
    delta: deltaPerSegment,
    slope: 0,
    variance: 100,
    spread: 900,
    n,
    level,
    fallback: false,
    holdRate: hold?.rate ?? 0,
    holdN: hold?.n ?? 0,
  })
}

// ---------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------

test('the more certain estimator dominates, without anyone tuning a weight', () => {
  const f = fuse([
    { name: 'profile', time: 1000, variance: 100 },
    { name: 'agency', time: 1600, variance: 10_000 },
  ])!
  assert.ok(f.time < 1010, `expected the tight estimator to win, got ${f.time}`)
  assert.ok(f.variance < 100, 'and two estimators to be better than one')
  assert.ok(f.weights.find((w) => w.name === 'profile')!.weight > 0.98)
})

test('fusing nothing usable returns nothing rather than zero', () => {
  assert.equal(fuse([]), null)
  assert.equal(fuse([{ name: 'agency', time: NaN, variance: 1 } as Estimator]), null)
  assert.equal(fuse([{ name: 'agency', time: 5, variance: 0 }]), null)
})

test('disagreement is reported separately, because fusion hides it', () => {
  const wide: Estimator[] = [
    { name: 'profile', time: 1000, variance: 100 },
    { name: 'agency', time: 1900, variance: 100 },
  ]
  const f = fuse(wide)!
  assert.ok(f.variance < 100, 'the fused variance looks confident')
  assert.equal(disagreement(wide), 900, 'while the estimators are fifteen minutes apart')
})

// ---------------------------------------------------------------------------
// Propagation
// ---------------------------------------------------------------------------

test('increments accumulate along a trip', () => {
  const p = propagate(trip([]), DATE, 0, 5, 0, flatProfile(20), null)
  assert.equal(p.steps, 5)
  assert.equal(Math.round(p.deviation), 100)
})

test('a recovery slope makes the propagation settle instead of running away', () => {
  const recovering = (): Estimate => ({
    delta: 30,
    slope: -0.3,
    variance: 100,
    spread: 900,
    n: 100,
    level: Level.SegmentDayBucket,
    fallback: false,
    holdRate: 0,
    holdN: 0,
  })
  const short = propagate(trip([]), DATE, 0, 3, 0, recovering, null)
  const long = propagate(trip([]), DATE, 0, 11, 0, recovering, null)

  // A random walk would reach 11 * 30 = 330s. An AR(1) with this slope settles near 100.
  assert.ok(long.deviation < 130, `expected an equilibrium, got ${long.deviation}`)
  assert.ok(long.deviation > short.deviation, 'while still being monotone in distance')
})

test('a long propagation is less certain than the naive sum of its parts', () => {
  const p = propagate(trip([]), DATE, 0, 10, 0, flatProfile(20), null)
  const naive = 10 * 100
  assert.ok(p.variance > naive * 2, `adjacent segments share their causes: ${p.variance}`)
  assert.ok(Math.abs(p.variance - naive * (1 + 9 * SEGMENT_CORRELATION)) < 1)
})

test('an early vehicle is held at a timepoint rather than predicted still earlier', () => {
  // Running four minutes early, on a route that holds at stop index 5.
  const p = propagate(trip([5]), DATE, 0, 8, -240, flatProfile(0), null)
  assert.deepEqual(p.heldAt, [5])
  assert.ok(p.deviation >= 0, `a held bus does not leave early: ${p.deviation}`)
  assert.ok(p.basis.hold > 200, 'and the hold is attributed, not hidden in the profile term')
})

test('an operator that flags every stop as a timepoint is not holding everywhere', () => {
  // Measured on the real regional feed: BART and Caltrain flag 100% of their stops, while
  // Muni flags 19%, Golden Gate 21% and SamTrans 37%. A flag on everything is not a claim
  // that the operator holds everywhere -- it is a producer that does not populate the field.
  //
  // Applied literally it would mean no BART train is ever predicted ahead of schedule
  // anywhere, which is false and, from outside, unfalsifiable.
  const rail = { ...trip([...Array(12).keys()]), timepointsInformative: false }
  assert.equal(timepointsAreInformative(rail.stops), false)
  assert.equal(holdsAt(rail, 5), false)

  const p = propagate(rail, DATE, 0, 8, -240, flatProfile(0), null)
  assert.equal(p.deviation, -240, 'a train running early stays early')
  assert.deepEqual(p.heldAt, [])

  // The same trip from an operator that flags selectively does hold.
  const bus = trip([5])
  assert.equal(timepointsAreInformative(bus.stops), true)
  assert.equal(holdsAt(bus, 5), true)
  assert.ok(propagate(bus, DATE, 0, 8, -240, flatProfile(0), null).deviation >= 0)
})

// ---------------------------------------------------------------------------
// Which stops hold, measured rather than assumed
// ---------------------------------------------------------------------------

/** An observation of a vehicle arriving `earlyBy` seconds early and leaving `leftEarlyBy`. */
function holdCase(earlyBy: number, leftEarlyBy: number): Deviation {
  return {
    agency: 'SM', tripId: 'SM:1', routeId: 'SM:172', directionId: 0, patternId: 'p',
    blockId: 'B', serviceDate: DATE, stopId: 'SM:105', seq: 6,
    scheduledArrival: T0, scheduledDeparture: T0,
    actualDeparture: T0 - leftEarlyBy,
    devDeparture: -leftEarlyBy,
    priorDev: -earlyBy,
    delta: earlyBy - leftEarlyBy,
    scheduledRun: 120, bucket: 16, dayType: 2,
    timepoint: false, held: false, tier: 0, sigma: 12, composite: true, predictions: [],
  }
}

test('only an early arrival is an opportunity to observe holding', () => {
  // A vehicle that was already on time would have left on time either way, so it says
  // nothing about whether the stop holds.
  assert.equal(holdOpportunity(holdCase(240, 0)), true)
  assert.equal(holdOpportunity(holdCase(10, 0)), false)
  assert.equal(holdOpportunity({ ...holdCase(240, 0), priorDev: undefined }), false)
})

test('the hold detector works without an arrival time', () => {
  // Most producers publish one time per stop, so a detector that needed devArrival would
  // only work on the two operators that need it least. This keys on the deviation the
  // vehicle carried *into* the stop, which is always available.
  const held = holdCase(240, 0)
  assert.equal(held.devArrival, undefined)
  assert.equal(holdEvidence(held), 1)
})

test('an early vehicle let straight through is evidence the stop does not hold', () => {
  assert.equal(holdEvidence(holdCase(240, 235)), 0, 'arrived early, left early')
  assert.equal(holdEvidence(holdCase(240, 200)), 0, 'gave up 40s but is still 3 min early')
  assert.equal(holdEvidence(holdCase(240, 30)), 1, 'gave up almost all of it')
})

test('measurement beats the timetable in both directions', () => {
  const holds = { rate: 0.9, n: 40 }
  const doesNot = { rate: 0.05, n: 40 }

  // A flagged stop that demonstrably lets vehicles through stops being clamped.
  assert.equal(shouldHold(doesNot, true), false)
  // And an UNFLAGGED stop that demonstrably holds starts being clamped -- which is the case
  // the flag can never give us, and is common: terminals, layover points, bridge and tunnel
  // entrances that no timetable marks.
  assert.equal(shouldHold(holds, false), true)
})

test('with too little evidence the timetable is all there is', () => {
  const thin = { rate: 1, n: MIN_HOLD_EVIDENCE - 1 }
  assert.equal(shouldHold(thin, false), false, 'seven mornings agreeing is not a rule')
  assert.equal(shouldHold(thin, true), true)
  assert.equal(shouldHold(null, true), true)
  assert.equal(shouldHold(null, false), false)
})

test('never observed is not the same as never holds', () => {
  // The zero that means "no data" must not be read as the zero that means "lets everyone
  // through", or every stop would stop being clamped the moment a route is first seen.
  assert.equal(shouldHold({ rate: 0, n: 0 }, true), true)
  assert.equal(shouldHold({ rate: 0, n: 40 }, true), false)
})

test('a stop measured as holding is clamped even where the timetable says nothing', () => {
  const t = trip([]) // no stop flagged as a timepoint anywhere
  const measured = flatProfile(0, 100, Level.SegmentDayBucket, { rate: 0.9, n: 40 })

  const p = propagate(t, DATE, 0, 8, -240, measured, null)
  assert.ok(p.deviation >= 0, `a stop that demonstrably holds does hold: ${p.deviation}`)
  assert.ok(p.heldAt.length > 0)
})

test('a flagged stop measured as not holding lets an early vehicle through', () => {
  const t = trip([5]) // stop 5 flagged
  const measured = flatProfile(0, 100, Level.SegmentDayBucket, { rate: 0.02, n: 60 })

  const p = propagate(t, DATE, 0, 8, -240, measured, null)
  assert.equal(p.deviation, -240, 'the measurement overrides the flag')
  assert.deepEqual(p.heldAt, [])
})

test('without a timepoint the same vehicle stays early', () => {
  const p = propagate(trip([]), DATE, 0, 8, -240, flatProfile(0), null)
  assert.equal(p.deviation, -240)
  assert.equal(p.basis.hold, 0)
})

// ---------------------------------------------------------------------------
// The stated case
// ---------------------------------------------------------------------------

test('a route that reliably runs early is predicted early', () => {
  // The case this whole system exists for: the 172 into Copeland on a Friday morning is
  // habitually minutes ahead of its timetable, and the schedule-based estimator should say
  // so rather than quoting the timetable back.
  const t = trip([])
  const early = flatProfile(-95, 120) // ~95 seconds gained per segment
  const p = propagate(t, DATE, 0, 11, 0, early, null)
  assert.ok(p.deviation < -900, `expected the profile to see it, got ${p.deviation}s`)

  const out = predict({
    trip: t,
    serviceDate: DATE,
    now: T0,
    target: 11,
    anchor: { index: 0, deviation: 0, at: T0 },
    profileFor: early,
  })!
  const scheduled = epochSecondsFor(DATE, t.stops[11].departure)
  assert.ok(out.time < scheduled - 600, 'and the prediction to be minutes ahead of schedule')
  assert.equal(out.confidence, 'high')
  assert.ok(out.basis.profile < -900, 'attributed to the profile, visibly')
})

// ---------------------------------------------------------------------------
// Clamps
// ---------------------------------------------------------------------------

test('with no evidence the agency prediction is returned untouched', () => {
  const t = trip([])
  const raw = T0 + 900
  const out = predict({
    trip: t,
    serviceDate: DATE,
    now: T0,
    target: 8,
    anchor: { index: 0, deviation: 0, at: T0 },
    agencyPrediction: raw,
    profileFor: () => ({ ...noEstimate(), delta: -300 }),
  })!
  assert.equal(out.time, raw, 'a profile with nothing behind it must not move the answer')
  assert.equal(out.correctionSeconds, 0)
  assert.equal(out.confidence, 'none')
})

test('a correction is capped relative to how far out the prediction is', () => {
  assert.equal(correctionCap(0), 90)
  assert.equal(correctionCap(120), 90)
  assert.equal(correctionCap(3600), 900)
})

test('a correction is shrunk continuously rather than switched on at a threshold', () => {
  assert.ok(Math.abs(temper(600, 0)) < 1e-9)
  assert.ok(temper(600, 15) === 300)
  assert.ok(temper(600, 300) > 570)
  // The property that matters, stated against the thing it replaced: a hard threshold at
  // n = 15 would swing the served number by hundreds of seconds the instant one more
  // observation arrived. Shrinkage's largest single step is under a tenth of that.
  let biggestStep = 0
  for (let n = 1; n < 200; n++) {
    biggestStep = Math.max(biggestStep, Math.abs(temper(600, n) - temper(600, n - 1)))
    assert.ok(temper(600, n) >= temper(600, n - 1), 'and it is monotone')
  }
  assert.ok(biggestStep < 45, `largest step ${biggestStep}`)
  assert.ok(biggestStep < (600 - correctionCap(0)) / 10)
})

test('a prediction is never earlier than the vehicle could physically get there', () => {
  const t = trip([])
  const out = predict({
    trip: t,
    serviceDate: DATE,
    now: T0,
    target: 11,
    // Just left stop 0; eleven two-minute hops remain.
    anchor: { index: 0, deviation: 0, at: T0 },
    profileFor: flatProfile(-600, 500),
  })!
  assert.ok(out.time >= T0 + 660, `a bus cannot cover 22 minutes of route in none: +${out.time - T0}`)
  assert.ok(out.clamps.includes('unreachable'))
})

test('nothing is predicted in the past', () => {
  const t = trip([])
  const out = predict({
    trip: t,
    serviceDate: DATE,
    now: T0 + 4000,
    target: 3,
    anchor: { index: 2, deviation: 0, at: T0 + 3900 },
    profileFor: flatProfile(-3000, 500),
  })!
  assert.ok(out.time >= T0 + 4000)
  assert.ok(out.clamps.includes('past') || out.clamps.includes('unreachable'))
})

test('a timepoint is never predicted before its published time', () => {
  const t = trip([9])
  const out = predict({
    trip: t,
    serviceDate: DATE,
    now: T0,
    target: 9,
    anchor: { index: 0, deviation: -600, at: T0 },
    profileFor: flatProfile(0, 500),
  })!
  assert.ok(out.time >= epochSecondsFor(DATE, t.stops[9].departure))
  assert.ok(out.clamps.includes('timepoint-hold') || out.basis.hold > 0)
})

test('every clamp that fired is named, so a model that is all clamp is visible', () => {
  const t = trip([])
  const out = predict({
    trip: t,
    serviceDate: DATE,
    now: T0,
    target: 11,
    anchor: { index: 0, deviation: 0, at: T0 },
    agencyPrediction: T0 + 1320,
    profileFor: flatProfile(-600, 4),
  })!
  assert.ok(out.clamps.length > 0)
  assert.ok(out.clamps.includes('tempered') || out.clamps.includes('capped'))
})

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

test('confidence follows the evidence, not the size of the correction', () => {
  const strong = { n: 200, level: Level.SegmentDayBucket, estimators: 2, disagreementSeconds: 30, hasAgency: true }
  assert.equal(confidenceOf(strong), 'high')
  assert.equal(confidenceOf({ ...strong, n: 12, level: Level.Segment }), 'medium')
  assert.equal(confidenceOf({ ...strong, n: 2 }), 'none')
  assert.equal(confidenceOf({ ...strong, level: Level.Route }), 'none')
  assert.equal(confidenceOf({ ...strong, disagreementSeconds: 900 }), 'low')
})

// ---------------------------------------------------------------------------
// Same-day block state
// ---------------------------------------------------------------------------

test('a driver who consistently beats the profile builds a negative residual', () => {
  let s = null as ReturnType<typeof updateBlock> | null
  for (let i = 0; i < 8; i++) {
    s = updateBlock(s, {
      serviceDate: DATE,
      tripId: 'SM:9001',
      at: T0 + i * 120,
      dev: -20 * i,
      delta: -25,
      expected: 0,
    }, 'V1')
  }
  assert.ok(s!.residual < -20, `expected a hot driver, got ${s!.residual}`)
  assert.equal(s!.observed, 8)
  assert.ok(blockProjection(s, 5) < -60)
  assert.ok(blockConfidence(s) > 0.6)
})

test('a bus on a slow corridor is not mistaken for a slow driver', () => {
  // Late every segment, but exactly as late as the profile said it would be.
  let s = null as ReturnType<typeof updateBlock> | null
  for (let i = 0; i < 8; i++) {
    s = updateBlock(s, {
      serviceDate: DATE,
      tripId: 'SM:9001',
      at: T0 + i * 120,
      dev: 40 * i,
      delta: 40,
      expected: 40,
    }, 'V1')
  }
  assert.ok(Math.abs(s!.residual) < 1, 'the corridor already explains it')
  assert.equal(blockProjection(s, 10), 0)
})

test('one segment is not a pattern', () => {
  const one = updateBlock(null, {
    serviceDate: DATE, tripId: 'SM:9001', at: T0, dev: -120, delta: -120, expected: 0,
  }, 'V1')
  const many = { ...one, observed: 40 }
  // Compared over a single segment, so the total cap is not what is being measured.
  assert.ok(Math.abs(blockProjection(one, 1)) < Math.abs(blockProjection(many, 1)) / 2)
  // And the cap still binds when a strong bias is projected a long way.
  assert.equal(blockProjection(many, 40), -MAX_BLOCK_SECONDS)
})

test('the same-day term is capped however extreme one segment was', () => {
  const wild = { ...emptyBlockState('V1', DATE, T0), residual: -600, observed: 50 }
  assert.equal(blockProjection(wild, 40), -MAX_BLOCK_SECONDS)
})

test('a long break is a new run with a new driver, not a quiet spell', () => {
  const before = updateBlock(null, {
    serviceDate: DATE, tripId: 'SM:9001', at: T0, dev: -100, delta: -50, expected: 0,
  }, 'V1')
  const after = updateBlock(before, {
    serviceDate: DATE, tripId: 'SM:9002', at: T0 + RUN_BREAK_SECONDS + 60, dev: 0, delta: 10, expected: 0,
  }, 'V1')
  assert.equal(after.observed, 1, 'the previous driver’s bias does not carry across a relief')
  assert.equal(after.residual, 10)
})

test('a new service date starts clean', () => {
  const yesterday = updateBlock(null, {
    serviceDate: '2026-09-03', tripId: 'SM:9001', at: T0 - 86_400, dev: 0, delta: -60, expected: 0,
  }, 'V1')
  const today = updateBlock(yesterday, {
    serviceDate: DATE, tripId: 'SM:9001', at: T0, dev: 0, delta: 0, expected: 0,
  }, 'V1')
  assert.equal(today.observed, 1)
})

// ---------------------------------------------------------------------------
// Layovers
// ---------------------------------------------------------------------------

test('a scheduled layover absorbs lateness, which is what it is for', () => {
  // Twelve minutes late into a terminal with a fifteen-minute layover: leaves on time.
  assert.equal(absorbLayover(720, 900), 0)
  // Twelve minutes late with a five-minute layover: three minutes of it survives.
  assert.equal(absorbLayover(720, 300), 540)
  // Early in is simply on time out.
  assert.equal(absorbLayover(-300, 900), 0)
})

test('a layover shorter than the minimum turn absorbs nothing', () => {
  assert.equal(absorbLayover(600, 60), 600)
})

test('bunching is measured against the headway, not the timetable', () => {
  assert.equal(bunching(360, 60).state, 'bunched')
  assert.equal(bunching(360, 900).state, 'gapped')
  assert.equal(bunching(360, 340).state, 'normal')
  assert.equal(bunching(0, 100).state, 'unknown')
})
