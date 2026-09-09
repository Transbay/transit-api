import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Level,
  emptyCell,
  updateSeconds,
  updateRate,
  rebase,
  estimate,
  smoothBuckets,
  dayTypeChain,
  packProfile,
  unpackProfile,
  band,
  isRateLevel,
  type Cell,
  type Observation,
  type PackedSegment,
} from './profile.js'
import { newHistogram, addToHistogram, emptyRegression } from './stats.js'
import { DayType, BUCKETS_PER_DAY } from './servicedate.js'

const T0 = 1_760_000_000

function obs(delta: number, over = 120, priorDev?: number): Observation {
  return { delta, scheduledRun: over, weight: 1, noiseVariance: 0, at: T0, priorDev }
}

function cellOf(deltas: number[], scheduledRun = 120, hist = false): Cell {
  let c = emptyCell(scheduledRun, T0)
  for (const d of deltas) c = updateSeconds(c, obs(d, scheduledRun), hist)
  return c
}

function rateCellOf(deltas: number[], over: number): Cell {
  let c = emptyCell(over, T0)
  for (const d of deltas) c = updateRate(c, obs(d, over))
  return c
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

test('with nothing at all, the estimate says so rather than saying zero confidently', () => {
  const e = estimate({ cells: {}, scheduledRun: 120, now: T0 })
  assert.equal(e.delta, 0)
  assert.equal(e.fallback, true)
  assert.equal(e.n, 0)
})

test('a segment with real evidence outvotes the agency fallback', () => {
  const e = estimate({
    cells: {
      [Level.Agency]: rateCellOf([6, 6, 6, 6, 6, 6, 6, 6, 6, 6], 120),
      [Level.SegmentDayBucket]: cellOf(new Array(200).fill(-45)),
    },
    scheduledRun: 120,
    now: T0,
  })
  assert.ok(e.delta < -35, `expected the segment's own -45s to dominate, got ${e.delta}`)
  assert.equal(e.level, Level.SegmentDayBucket)
  assert.equal(e.fallback, false)
})

test('a segment with two observations mostly defers to its parent', () => {
  const e = estimate({
    cells: {
      [Level.Agency]: rateCellOf(new Array(200).fill(12), 120),
      [Level.SegmentDayBucket]: cellOf([-300, -300]),
    },
    scheduledRun: 120,
    now: T0,
  })
  // Two samples must not be allowed to assert a five-minute effect.
  assert.ok(e.delta > -180, `two samples asserted too much: ${e.delta}`)
  assert.ok(e.delta < 12, 'but they are not ignored either')
})

test('the pooled rungs are rates, so they scale to the segment being asked about', () => {
  // "Vehicles run 10% over schedule on this route" -- 12s on a 2-minute hop, 90s on a
  // 15-minute one. A rung held in seconds would give both the same number.
  const agency = rateCellOf(new Array(100).fill(12), 120)

  const short = estimate({ cells: { [Level.Agency]: agency }, scheduledRun: 120, now: T0 })
  const long = estimate({ cells: { [Level.Agency]: agency }, scheduledRun: 900, now: T0 })

  assert.ok(Math.abs(short.delta - 12) < 0.5, `short ${short.delta}`)
  assert.ok(Math.abs(long.delta - 90) < 3, `long ${long.delta}`)
  assert.ok(isRateLevel(Level.Agency) && !isRateLevel(Level.Segment))
})

test('a thin cell reports a wider uncertainty than a fat one with the same spread', () => {
  const thin = estimate({ cells: { [Level.SegmentDayBucket]: cellOf([10, 30, 20]) }, scheduledRun: 120, now: T0 })
  const fat = estimate({
    cells: { [Level.SegmentDayBucket]: cellOf(new Array(300).fill(0).map((_, i) => 10 + (i % 21))) },
    scheduledRun: 120,
    now: T0,
  })
  assert.ok(thin.variance > fat.variance * 5, `${thin.variance} vs ${fat.variance}`)
})

test('a slope is only taken from a segment rung, and only with evidence behind it', () => {
  // A recovery segment: it gives back a third of whatever delay arrives.
  let c = emptyCell(120, T0)
  for (let d = -240; d <= 600; d += 20) c = updateSeconds(c, obs(-d / 3, 120, d), false)

  const withEvidence = estimate({ cells: { [Level.SegmentDayBucket]: c }, scheduledRun: 120, now: T0 })
  assert.ok(withEvidence.slope < -0.1, `expected a recovery slope, got ${withEvidence.slope}`)

  let thin = emptyCell(120, T0)
  for (const d of [-100, 0, 100]) thin = updateSeconds(thin, obs(-d / 3, 120, d), false)
  const noEvidence = estimate({ cells: { [Level.SegmentDayBucket]: thin }, scheduledRun: 120, now: T0 })
  assert.equal(noEvidence.slope, 0, 'three points is not a slope')
})

test('the design effect makes a cell count for less than its row count', () => {
  const cells = { [Level.SegmentDayBucket]: cellOf(new Array(100).fill(-30)) }
  const independent = estimate({ cells, scheduledRun: 120, perCluster: 1, now: T0 })
  const clustered = estimate({ cells, scheduledRun: 120, perCluster: 4, now: T0 })
  assert.ok(clustered.n < independent.n / 2, `${clustered.n} vs ${independent.n}`)
  assert.ok(clustered.variance > independent.variance, 'and is correspondingly less certain')
})

test('a stale cell has decayed by the time it is read', () => {
  const cells = { [Level.SegmentDayBucket]: cellOf(new Array(40).fill(-60)) }
  const fresh = estimate({ cells, scheduledRun: 120, now: T0 })
  const old = estimate({ cells, scheduledRun: 120, now: T0 + 63 * 86_400 })
  assert.ok(old.n < fresh.n / 7, `three half-lives should leave an eighth: ${old.n} of ${fresh.n}`)
})

// ---------------------------------------------------------------------------
// Schedule changes
// ---------------------------------------------------------------------------

test('a timetable change re-bases the evidence instead of discarding it', () => {
  // Ninety observations of "this segment runs 30s over its scheduled 120s". The planner
  // then gives it 150s. The corridor did not change; the baseline did.
  const before = cellOf(new Array(90).fill(30), 120)
  const after = rebase(before, 150)

  assert.ok(Math.abs(after.moments.mean - 0) < 1e-6, 'now running exactly to schedule')
  assert.ok(after.moments.n > 0, 'the evidence survives')
  assert.ok(after.moments.n < before.moments.n, 'but is discounted once')
  assert.equal(after.scheduledRun, 150)
  assert.equal(after.histogram, undefined, 'the old distribution was drawn against the old baseline')
})

test('re-basing a cell that never knew its baseline just records one', () => {
  const c = rebase(emptyCell(0, T0), 240)
  assert.equal(c.scheduledRun, 240)
  assert.equal(c.moments.n, 0)
})

// ---------------------------------------------------------------------------
// Smoothing
// ---------------------------------------------------------------------------

test('neighbouring half hours pool, so the estimate does not jump at :30', () => {
  const byBucket = new Map<number, Cell>()
  byBucket.set(16, cellOf([60, 60, 60, 60]))
  byBucket.set(17, cellOf([64, 64, 64, 64]))
  byBucket.set(18, cellOf([200, 200, 200, 200]))

  const at17 = smoothBuckets(byBucket, 17)!
  // 17 keeps its own centre but is pulled by both sides, so it lands between them and
  // moves smoothly rather than stepping.
  assert.ok(at17.moments.mean > 64 && at17.moments.mean < 120, `${at17.moments.mean}`)
  assert.ok(at17.moments.n > byBucket.get(17)!.moments.n, 'and has more evidence than alone')
})

test('smoothing an empty neighbourhood returns nothing rather than a zero', () => {
  assert.equal(smoothBuckets(new Map(), 20), undefined)
})

test('smoothing does not run off either end of the service day', () => {
  const byBucket = new Map<number, Cell>([[0, cellOf([10, 10])]])
  assert.ok(smoothBuckets(byBucket, 0))
  assert.equal(smoothBuckets(byBucket, BUCKETS_PER_DAY - 1), undefined)
})

test('day types fall back somewhere with data', () => {
  assert.deepEqual(dayTypeChain(DayType.Fri), [DayType.Fri, DayType.TueThu])
  assert.deepEqual(dayTypeChain(DayType.Hol), [DayType.Hol, DayType.Sun])
  assert.deepEqual(dayTypeChain(DayType.Sat), [DayType.Sat])
})

// ---------------------------------------------------------------------------
// The packed form
// ---------------------------------------------------------------------------

function samplePacked(): PackedSegment {
  const buckets: PackedSegment['buckets'] = new Array(BUCKETS_PER_DAY).fill(null)
  buckets[16] = { mean: -45, sd: 60, n: 84 }
  buckets[36] = { mean: 130, sd: 180, n: 21 }
  return {
    key: 'SF:15419>SF:15420',
    scheduledRun: 145,
    slope: -0.31,
    meanAll: 12,
    sdAll: 96,
    nAll: 640,
    holdRate: 0.82,
    holdN: 34,
    buckets,
  }
}

test('a profile blob round-trips', () => {
  const original = samplePacked()
  const back = unpackProfile(packProfile([original])).get(original.key)!

  assert.equal(back.key, original.key)
  assert.equal(back.scheduledRun, 145)
  assert.ok(Math.abs(back.slope - -0.31) < 0.001)
  assert.equal(back.meanAll, 12)
  assert.equal(back.sdAll, 96)
  assert.equal(back.nAll, 640)
  assert.ok(Math.abs(back.holdRate - 0.82) < 0.01, `hold rate ${back.holdRate}`)
  assert.equal(back.holdN, 34)
  assert.deepEqual(back.buckets[16], { mean: -45, sd: 60, n: 84 })
  assert.equal(back.buckets[17], null)
})

test('an empty bucket is distinguishable from a bucket whose mean is zero', () => {
  const s = samplePacked()
  s.buckets[20] = { mean: 0, sd: 40, n: 9 }
  const back = unpackProfile(packProfile([s])).get(s.key)!
  assert.deepEqual(back.buckets[20], { mean: 0, sd: 40, n: 9 })
  assert.equal(back.buckets[21], null)
})

test('a whole route fits in the budget it was designed for', () => {
  const segments = Array.from({ length: 50 }, (_, i) => ({
    ...samplePacked(),
    key: `SF:1${String(i).padStart(4, '0')}>SF:1${String(i + 1).padStart(4, '0')}`,
  }))
  const size = packProfile(segments).length
  assert.ok(size < 20_000, `50 segments packed to ${size} bytes`)
  assert.equal(unpackProfile(packProfile(segments)).size, 50)
})

test('a blob from an older build is discarded rather than misread', () => {
  const buf = packProfile([samplePacked()])
  buf.writeUInt8(1, 0)
  assert.equal(unpackProfile(buf).size, 0)
})

test('a truncated blob does not throw', () => {
  const buf = packProfile([samplePacked()])
  assert.doesNotThrow(() => unpackProfile(buf.subarray(0, 40)))
})

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

test('a band drawn from a histogram is asymmetric, because delay is', () => {
  const h = newHistogram()
  // Buses are never very early and occasionally very late.
  for (let i = 0; i < 200; i++) addToHistogram(h, -20 + (i % 60))
  for (let i = 0; i < 25; i++) addToHistogram(h, 400 + i * 20)

  const b = band(0, 3600, h)
  assert.equal(b.fromHistogram, true)
  assert.ok(Math.abs(b.high) > Math.abs(b.low) * 2, `${b.low} .. ${b.high}`)
})

test('without a histogram the band is symmetric and says so', () => {
  const b = band(30, 2500, undefined)
  assert.equal(b.fromHistogram, false)
  assert.ok(Math.abs(b.high - 30 - (30 - b.low)) < 1e-6)
})

test('the histogram supplies the shape and the ladder supplies the centre', () => {
  const h = newHistogram()
  for (let i = 0; i < 100; i++) addToHistogram(h, i % 40)
  const atZero = band(0, 3600, h)
  const atMinus = band(-600, 3600, h)
  assert.ok(Math.abs(atMinus.low - (atZero.low - 600)) < 1e-6, 'shifted, not redrawn')
  assert.ok(Math.abs(atMinus.high - (atZero.high - 600)) < 1e-6)
})
