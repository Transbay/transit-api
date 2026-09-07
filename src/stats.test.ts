import test from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyMoments,
  observe,
  decayTo,
  variance,
  stdev,
  mergeMoments,
  huberWeight,
  huberThreshold,
  shrink,
  shrunkVariance,
  shrinkVariance,
  estimateK,
  designEffect,
  effectiveN,
  emptyRegression,
  regress,
  fit,
  clampSlope,
  newHistogram,
  addToHistogram,
  mergeHistogram,
  decayHistogram,
  histogramTotal,
  quantile,
  robustScale,
  binOf,
  binRange,
  deconvolve,
  HIST_BINS,
} from './stats.js'

const DAY = 86_400
const T0 = 1_760_000_000

function feed(values: number[], at = T0, weight = 1) {
  let m = emptyMoments(at)
  for (const v of values) m = observe(m, v, at, weight)
  return m
}

// ---------------------------------------------------------------------------
// Moments
// ---------------------------------------------------------------------------

test('undecayed moments are the ordinary mean and variance', () => {
  const m = feed([10, 20, 30, 40])
  assert.equal(m.n, 4)
  assert.equal(m.mean, 25)
  assert.equal(variance(m), 125) // population variance of 10,20,30,40
})

test('one half-life halves the weight but not the mean', () => {
  const m = feed([100, 100, 100, 100])
  const later = decayTo(m, T0 + 21 * DAY)
  assert.ok(Math.abs(later.n - 2) < 1e-9)
  assert.equal(later.mean, 100)
})

test('decaying in two steps equals decaying in one', () => {
  const m = feed([5, 9, 14])
  const direct = decayTo(m, T0 + 30 * DAY)
  const stepwise = decayTo(decayTo(m, T0 + 11 * DAY), T0 + 30 * DAY)
  assert.ok(Math.abs(direct.n - stepwise.n) < 1e-9)
  assert.ok(Math.abs(variance(direct) - variance(stepwise)) < 1e-9)
})

test('old evidence is outvoted by new', () => {
  // Ten observations of "always 5 minutes late", then a month of "on time".
  let m = emptyMoments(T0)
  for (let i = 0; i < 10; i++) m = observe(m, 300, T0)
  for (let i = 0; i < 10; i++) m = observe(m, 0, T0 + 30 * DAY)
  assert.ok(m.mean < 100, `expected the recent evidence to dominate, got ${m.mean}`)
})

test('merging two summaries equals summarising the union', () => {
  const a = feed([1, 2, 3, 4])
  const b = feed([100, 101, 102])
  const merged = mergeMoments(a, b)
  const direct = feed([1, 2, 3, 4, 100, 101, 102])
  assert.ok(Math.abs(merged.mean - direct.mean) < 1e-9)
  assert.ok(Math.abs(variance(merged) - variance(direct)) < 1e-6)
})

test('weight scales influence, not value', () => {
  const light = observe(observe(emptyMoments(T0), 0, T0, 1), 100, T0, 1)
  const heavy = observe(observe(emptyMoments(T0), 0, T0, 1), 100, T0, 3)
  assert.equal(light.mean, 50)
  assert.equal(heavy.mean, 75)
})

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test('Huber is invisible when nothing is wrong', () => {
  for (const x of [-40, 0, 10, 44]) assert.equal(huberWeight(x, 0, 45), 1)
})

test('Huber damps an outlier in proportion to how far out it is', () => {
  assert.equal(huberWeight(90, 0, 45), 0.5)
  assert.equal(huberWeight(450, 0, 45), 0.1)
})

test('a Huber-damped incident moves the mean far less than it would raw', () => {
  const ordinary = [20, 25, 30, 22, 28]
  const c = huberThreshold(10)

  let raw = emptyMoments(T0)
  let robust = emptyMoments(T0)
  for (const x of [...ordinary, 1800]) {
    raw = observe(raw, x, T0)
    robust = observe(robust, x, T0, huberWeight(x, 25, c))
  }
  assert.ok(raw.mean > 290, `raw mean should be dragged, got ${raw.mean}`)
  assert.ok(robust.mean < 60, `robust mean should barely move, got ${robust.mean}`)
})

test('the Huber floor stops a young cell clipping ordinary data', () => {
  // A cell with almost no spread yet must not decide that 30 seconds is an outlier.
  assert.equal(huberThreshold(1), 45)
  assert.equal(huberWeight(30, 0, huberThreshold(1)), 1)
})

// ---------------------------------------------------------------------------
// Shrinkage
// ---------------------------------------------------------------------------

test('shrinkage runs from the parent to the cell as evidence arrives', () => {
  assert.equal(shrink(0, 999, 10, -60), -60, 'no evidence is exactly the parent')
  assert.equal(shrink(10, 0, 10, -60), -30, 'equal evidence is halfway')
  assert.ok(Math.abs(shrink(1000, 0, 10, -60) - 0) < 1, 'plenty of evidence is the cell')
})

test('a thin cell reports a wide uncertainty even with a tight sample', () => {
  const s2 = 2500 // 50 s of spread
  assert.ok(shrunkVariance(2, s2, 10) > shrunkVariance(200, s2, 10) * 10)
})

test('variance shrinks toward the parent too', () => {
  // A cell of three observations that happen to agree must not claim to be certain.
  assert.ok(shrinkVariance(3, 1, 8, 2500) > 1500)
  assert.ok(shrinkVariance(500, 1, 8, 2500) < 60)
})

test('k is large when children are indistinguishable', () => {
  const same = [
    { n: 40, mean: 10 },
    { n: 40, mean: 11 },
    { n: 40, mean: 9 },
    { n: 40, mean: 10.5 },
  ]
  assert.equal(estimateK(same, 2500), 200, 'never trust a child that says nothing new')
})

test('k is small when children genuinely differ', () => {
  const differ = [
    { n: 40, mean: -180 },
    { n: 40, mean: 0 },
    { n: 40, mean: 190 },
    { n: 40, mean: 60 },
  ]
  assert.ok(estimateK(differ, 2500) < 10, 'trust a child that carries real signal')
})

test('too few children to judge means defer to the parent', () => {
  assert.equal(estimateK([{ n: 100, mean: 5 }], 2500), 200)
})

test('the design effect discounts observations that share their causes', () => {
  assert.equal(designEffect(1, 0.5), 1)
  assert.equal(designEffect(4, 0.5), 2.5)
  assert.equal(effectiveN(100, designEffect(4, 0.5)), 40)
})

// ---------------------------------------------------------------------------
// Conditional response
// ---------------------------------------------------------------------------

test('recovers a known slope', () => {
  let r = emptyRegression(T0)
  // A segment that gives back a third of whatever delay arrives, plus 20s of its own.
  for (let d = -300; d <= 600; d += 30) r = regress(r, d, 20 - d / 3, T0)
  const f = fit(r, 0) // no slope shrinkage, so the recovery must be exact
  assert.ok(Math.abs(f.slope + 1 / 3) < 1e-6, `slope ${f.slope}`)
  assert.ok(Math.abs(f.intercept - 20) < 1e-6, `intercept ${f.intercept}`)
})

test('a thinly-evidenced slope is pulled toward zero', () => {
  let thin = emptyRegression(T0)
  for (const d of [-100, 0, 100]) thin = regress(thin, d, -d / 2, T0)
  const shrunk = fit(thin, 30)
  assert.ok(Math.abs(shrunk.slope) < 0.5, 'three points must not assert a strong slope')
  assert.ok(shrunk.slope < 0, 'but the sign survives')
})

test('a degenerate fit reports no slope rather than a huge one', () => {
  let r = emptyRegression(T0)
  for (let i = 0; i < 50; i++) r = regress(r, 0, 30 + i, T0) // no variation in x
  assert.equal(fit(r).slope, 0)
})

test('slopes are clamped to a stable range', () => {
  assert.equal(clampSlope(-5), -0.9)
  assert.equal(clampSlope(3), 0.6)
  assert.equal(clampSlope(-0.3), -0.3)
})

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

test('every value lands in exactly one bin, and bins tile in order', () => {
  for (let x = -1500; x <= 2400; x += 7) {
    const i = binOf(x)
    assert.ok(i >= 0 && i < HIST_BINS, `${x} -> ${i}`)
    if (i > 0 && i < HIST_BINS - 1) {
      const [lo, hi] = binRange(i)
      assert.ok(x >= lo && x < hi, `${x} not inside [${lo}, ${hi})`)
    }
  }
  for (let i = 1; i < HIST_BINS - 1; i++) {
    assert.equal(binRange(i)[1], binRange(i + 1)[0], `gap after bin ${i}`)
  }
})

test('quantiles track a skewed distribution', () => {
  const h = newHistogram()
  // 90 buses within a minute of schedule, 10 badly late. A mean would report ~2 minutes;
  // the median should not.
  for (let i = 0; i < 90; i++) addToHistogram(h, -30 + (i % 60))
  for (let i = 0; i < 10; i++) addToHistogram(h, 1200)

  const p50 = quantile(h, 0.5)!
  const p90 = quantile(h, 0.9)!
  const p95 = quantile(h, 0.95)!
  assert.ok(p50 > -30 && p50 < 60, `median ${p50}`)
  // Exactly 90 of the 100 are on time, so p90 sits on the boundary between the two
  // populations -- and p95 is deep in the tail the median refused to chase.
  assert.equal(p90, 30)
  assert.ok(p95 > 500, `p95 ${p95}`)

  // The point of the whole exercise: the mean is not a number anyone should act on.
  const mean = (90 * 0 + 10 * 1200) / 100
  assert.ok(mean > p50 * 3 + 100, 'the mean is dragged where the median is not')
})

test('an empty histogram has no quantile rather than a plausible zero', () => {
  assert.equal(quantile(newHistogram(), 0.5), null)
})

test('histograms merge by addition, which is what the ladder needs', () => {
  const a = newHistogram()
  const b = newHistogram()
  const both = newHistogram()
  for (const x of [10, 20, 30]) {
    addToHistogram(a, x)
    addToHistogram(both, x)
  }
  for (const x of [500, 600]) {
    addToHistogram(b, x)
    addToHistogram(both, x)
  }
  mergeHistogram(a, b)
  assert.equal(histogramTotal(a), 5)
  assert.deepEqual(Array.from(a), Array.from(both))
})

test('histogram decay matches moment decay', () => {
  const h = newHistogram()
  for (let i = 0; i < 8; i++) addToHistogram(h, 60)
  decayHistogram(h, 21)
  assert.ok(Math.abs(histogramTotal(h) - 4) < 1e-5)
})

test('robust scale ignores the tail a standard deviation would chase', () => {
  const h = newHistogram()
  for (let i = 0; i < 200; i++) addToHistogram(h, -60 + (i % 120))
  const clean = robustScale(h)
  for (let i = 0; i < 10; i++) addToHistogram(h, 1700)
  assert.ok(Math.abs(robustScale(h) - clean) < 20, 'the middle is where it should be')
})

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

test('deconvolution removes measurement noise and never goes negative', () => {
  assert.equal(deconvolve(2500, 900), 1600)
  assert.equal(deconvolve(400, 900), 0)
})

test('deconvolution is what stops a short segment reporting noise as spread', () => {
  // A 400m Muni hop: true increment varies by ~10s, each endpoint measured to +/-15s.
  const trueVar = 100
  const observed = trueVar + 2 * 225
  assert.ok(Math.abs(deconvolve(observed, 2 * 225) - trueVar) < 1e-9)
  assert.ok(stdev({ n: 1, mean: 0, m2: observed, updatedAt: 0 }) > 20)
  assert.ok(Math.sqrt(deconvolve(observed, 2 * 225)) === 10)
})
