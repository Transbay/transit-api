/**
 * The statistics the delay profile is built out of. Pure functions and plain structs —
 * no Redis, no config, no clock except the one passed in.
 *
 * Four ideas do all the work here:
 *
 * - **Decayed moments.** Every count is an exponentially decayed one, so a signal retimed
 *   in March stops arguing about June without anybody having to remember to delete it.
 * - **Shrinkage.** Most cells are thin. A thin cell is a weighted blend of its own
 *   evidence and its parent's, and the weight is `n / (n + k)` where k has a defensible
 *   value rather than a chosen one.
 * - **Huber weighting.** A bus stuck behind a crash is real data and belongs in the
 *   histogram; it does not belong at full weight in the mean. Trimming does not stream, so
 *   the observation is down-weighted as it arrives instead.
 * - **Histograms.** Delay is strongly right-skewed and nothing like Gaussian, so a mean
 *   and a standard deviation cannot produce an honest band. Histograms can, they merge by
 *   addition (which is exactly what walking the shrinkage ladder needs), and they are
 *   small enough to store.
 */

// ---------------------------------------------------------------------------
// Decayed moments
// ---------------------------------------------------------------------------

/**
 * Weighted, exponentially decayed mean and variance.
 *
 * Welford's algorithm with a decay applied before each update, so the whole history is
 * summarised in five numbers and no observation is ever revisited. `updatedAt` lets the
 * decay be applied lazily: a cell nobody has touched for a month costs nothing until it
 * is read.
 */
export interface Moments {
  /** Decayed sum of weights. Not an integer, and not a count of rows. */
  n: number
  mean: number
  /** Decayed sum of squared deviations. Variance is `m2 / n`. */
  m2: number
  /** Epoch seconds of the last update. */
  updatedAt: number
}

export function emptyMoments(at = 0): Moments {
  return { n: 0, mean: 0, m2: 0, updatedAt: at }
}

/** Half-life of the exponential decay, in days. */
export const DEFAULT_HALF_LIFE_DAYS = 21

/** The per-day decay factor for a given half-life. */
export function decayPerDay(halfLifeDays = DEFAULT_HALF_LIFE_DAYS): number {
  return Math.pow(0.5, 1 / halfLifeDays)
}

/**
 * Ages a cell forward to `now` without adding anything to it.
 *
 * Idempotent in the sense that matters: decaying to t then to t' equals decaying straight
 * to t'. Called on read as well as on write, so a stale cell never reports a stale weight.
 */
export function decayTo(m: Moments, now: number, halfLifeDays = DEFAULT_HALF_LIFE_DAYS): Moments {
  if (m.n === 0 || m.updatedAt === 0 || now <= m.updatedAt) {
    return { ...m, updatedAt: Math.max(m.updatedAt, now) }
  }
  const days = (now - m.updatedAt) / 86_400
  const f = Math.pow(decayPerDay(halfLifeDays), days)
  return { n: m.n * f, mean: m.mean, m2: m.m2 * f, updatedAt: now }
}

/**
 * Folds one observation in, decaying first.
 *
 * `weight` carries two separate things multiplied together: the observation's quality
 * (a tier-C sighting is worth a fraction of a tier-A one) and its Huber weight (an
 * outlier is worth less than an inlier). Keeping them as one number here is deliberate —
 * this function has no business knowing which is which.
 */
export function observe(
  m: Moments,
  x: number,
  at: number,
  weight = 1,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
): Moments {
  if (!Number.isFinite(x) || weight <= 0) return m
  const d = decayTo(m, at, halfLifeDays)

  const n = d.n + weight
  const delta = x - d.mean
  const mean = d.mean + (weight / n) * delta
  // The second factor uses the *updated* mean; that is what makes this Welford rather
  // than a naive sum of squares, and it is why this stays accurate over millions of
  // observations where `Σx²  − (Σx)²/n` would lose most of its significant digits.
  const m2 = d.m2 + weight * delta * (x - mean)

  return { n, mean, m2, updatedAt: at }
}

/** Population variance. Zero for an empty or single-observation cell. */
export function variance(m: Moments): number {
  if (m.n <= 0) return 0
  return Math.max(0, m.m2 / m.n)
}

export function stdev(m: Moments): number {
  return Math.sqrt(variance(m))
}

/** Merges two independent summaries. Used to build a ladder rung from its children. */
export function mergeMoments(a: Moments, b: Moments): Moments {
  if (a.n === 0) return { ...b }
  if (b.n === 0) return { ...a }
  const n = a.n + b.n
  const delta = b.mean - a.mean
  return {
    n,
    mean: a.mean + delta * (b.n / n),
    m2: a.m2 + b.m2 + delta * delta * ((a.n * b.n) / n),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  }
}

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

/**
 * Huber's weight: full weight inside `c`, falling off as `c/|deviation|` outside it.
 *
 * The alternative — a trimmed mean — needs the whole sample in hand, which a streaming
 * aggregate does not have. This gets most of the robustness for one multiplication, and
 * is exactly 1 for every inlying point, so it is invisible when nothing is wrong.
 */
export function huberWeight(x: number, centre: number, c: number): number {
  const d = Math.abs(x - centre)
  if (!(c > 0) || d <= c) return 1
  return c / d
}

/**
 * The Huber threshold for a cell: generous in absolute terms, and generous relative to
 * how noisy this particular cell already is.
 *
 * The floor matters more than the multiplier. Early in a cell's life its own scale
 * estimate is garbage, and a threshold derived from it would clip ordinary observations
 * into a self-confirming narrow distribution.
 */
export function huberThreshold(scale: number, floorSeconds = 45, k = 2.5): number {
  return Math.max(floorSeconds, k * scale)
}

// ---------------------------------------------------------------------------
// Shrinkage
// ---------------------------------------------------------------------------

/**
 * The blend: `(n·x̄ + k·parent) / (n + k)`.
 *
 * `k` is the prior's equivalent sample size — literally how many observations it takes
 * for a cell to outvote its parent. At n = 0 this is the parent exactly; at n >> k it is
 * the cell's own mean.
 */
export function shrink(n: number, mean: number, k: number, parent: number): number {
  if (!(n > 0)) return parent
  if (!(k > 0)) return mean
  return (n * mean + k * parent) / (n + k)
}

/**
 * Variance of the shrunk estimate itself — not of a single observation.
 *
 * This is the number the prediction fusion needs. Using the observation variance instead
 * would tell the fuser that a cell with two samples is as trustworthy as one with two
 * hundred, which is the standard way to make an ensemble worse than its best member.
 */
export function shrunkVariance(n: number, sigma2: number, k: number): number {
  return sigma2 / Math.max(1e-9, n + k)
}

/** Shrinks a cell's variance toward its parent's, so a thin cell cannot claim precision. */
export function shrinkVariance(n: number, s2: number, nu: number, parentS2: number): number {
  const denom = nu + Math.max(0, n - 1)
  if (denom <= 0) return parentS2
  return (nu * parentS2 + Math.max(0, n - 1) * s2) / denom
}

/**
 * Estimates `k` from the data instead of choosing it.
 *
 * `k = σ²_within / τ²_between`: how noisy one cell is, over how much the cells genuinely
 * differ from each other. Method of moments over a parent's children — the observed
 * spread of the child means is the true spread plus the sampling noise, so subtract the
 * noise off.
 *
 * Returns a large k when the children are indistinguishable (never trust a child over its
 * parent) and a small one when they genuinely differ (trust a child quickly). Both
 * extremes are right, and both are wrong if k is a constant chosen by taste.
 */
export function estimateK(
  children: { n: number; mean: number }[],
  withinVariance: number,
  bounds: { min: number; max: number } = { min: 2, max: 200 },
): number {
  const usable = children.filter((c) => c.n > 0)
  if (usable.length < 3 || !(withinVariance > 0)) return bounds.max

  let wSum = 0
  let wMean = 0
  for (const c of usable) {
    wSum += c.n
    wMean += c.n * c.mean
  }
  wMean /= wSum

  let between = 0
  for (const c of usable) between += c.n * (c.mean - wMean) ** 2
  between /= wSum

  // The observed spread of the child means already contains the noise in each of them.
  const meanInverseN = usable.reduce((s, c) => s + 1 / c.n, 0) / usable.length
  const tau2 = between - withinVariance * meanInverseN

  if (!(tau2 > 0)) return bounds.max
  return Math.min(bounds.max, Math.max(bounds.min, withinVariance / tau2))
}

/**
 * The design effect — the correction for the fact that our observations are not
 * independent.
 *
 * Consecutive trips on a route ten minutes apart share almost all of their causes: the
 * same signal timing, the same crash, the same rain. Counting them as independent
 * observations inflates every sample size in the system, which makes shrinkage
 * under-shrink and every confidence interval too narrow. `n_eff = n / DEFF`.
 *
 * With four observations a day into a cell and a within-day correlation around 0.5, DEFF
 * is 2.5 — so the honest sample size is well under half the row count.
 */
export function designEffect(observationsPerCluster: number, icc: number): number {
  const m = Math.max(1, observationsPerCluster)
  return 1 + (m - 1) * Math.min(0.95, Math.max(0, icc))
}

export function effectiveN(n: number, deff: number): number {
  return n / Math.max(1, deff)
}

// ---------------------------------------------------------------------------
// Conditional response — how a segment reacts to a vehicle that is already late
// ---------------------------------------------------------------------------

/**
 * Decayed sufficient statistics for `y = a + b·x`.
 *
 * Here x is the vehicle's deviation arriving at the segment and y is what the segment
 * then does to it. A negative b is a recovery segment — schedule slack that a late
 * vehicle eats into. A positive b is amplification — a late bus meets a bigger crowd at
 * every stop and falls further behind.
 *
 * This is the term that turns "delay is made up somewhere along here" from an anecdote
 * into a number, and it is also what stops the forward projection being a random walk:
 * with b in (−1, 0) the propagation is a stable AR(1) that settles, instead of a sum of
 * averages that grows without bound.
 */
export interface Regression {
  w: number
  sx: number
  sy: number
  sxx: number
  sxy: number
  updatedAt: number
}

export function emptyRegression(at = 0): Regression {
  return { w: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, updatedAt: at }
}

export function regress(
  r: Regression,
  x: number,
  y: number,
  at: number,
  weight = 1,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
): Regression {
  if (!Number.isFinite(x) || !Number.isFinite(y) || weight <= 0) return r
  const f =
    r.w === 0 || r.updatedAt === 0 || at <= r.updatedAt
      ? 1
      : Math.pow(decayPerDay(halfLifeDays), (at - r.updatedAt) / 86_400)

  return {
    w: r.w * f + weight,
    sx: r.sx * f + weight * x,
    sy: r.sy * f + weight * y,
    sxx: r.sxx * f + weight * x * x,
    sxy: r.sxy * f + weight * x * y,
    updatedAt: at,
  }
}

export interface Fit {
  intercept: number
  slope: number
  /** Weight behind the fit, for shrinking the slope toward zero. */
  n: number
}

/**
 * Least squares, with the slope shrunk toward zero by its own evidence.
 *
 * The shrinkage is not decoration. `x` here is a measured deviation, so it carries
 * measurement error, and a regression whose predictor is noisy is biased toward zero
 * *slope* in a way that gets worse as the noise grows — errors-in-variables. Shrinking a
 * thinly-evidenced slope toward zero costs a little of a real effect and avoids inventing
 * a large fake one, which is the right side of that trade for a cell with six samples.
 */
export function fit(r: Regression, kSlope = 30): Fit {
  if (r.w <= 1) return { intercept: r.w > 0 ? r.sy / r.w : 0, slope: 0, n: r.w }

  const meanX = r.sx / r.w
  const meanY = r.sy / r.w
  const sxx = r.sxx - r.w * meanX * meanX
  const sxy = r.sxy - r.w * meanX * meanY

  if (!(sxx > 1e-6)) return { intercept: meanY, slope: 0, n: r.w }

  const raw = sxy / sxx
  const slope = raw * (r.w / (r.w + kSlope))
  return { intercept: meanY - slope * meanX, slope, n: r.w }
}

/**
 * Keeps the propagation stable.
 *
 * A slope at or below −1 means "this segment removes more delay than the vehicle had",
 * which is not a thing; at or above +1 the forward projection diverges. Both are
 * arithmetic artefacts of a thin, noisy fit rather than observations about traffic.
 */
export function clampSlope(slope: number): number {
  return Math.min(0.6, Math.max(-0.9, slope))
}

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

/**
 * Bin edges, in seconds, for a delay distribution.
 *
 * Fine where the mass is and coarse in the tails: 15-second bins between −5 and +10
 * minutes, one-minute bins out to −15 and +30, and a catch-all at each end. 92 bins,
 * ~370 bytes as float32 — small enough to keep one per segment per day type, which is the
 * level where tail *shape* is actually a property of the thing being measured. Tail shape
 * does not vary meaningfully between two adjacent half-hours; the mean does.
 */
export const HIST_BINS = 92

const CORE_LO = -300
const CORE_HI = 600
const CORE_STEP = 15
const TAIL_LO = -900
const TAIL_HI = 1800
const TAIL_STEP = 60

const CORE_COUNT = (CORE_HI - CORE_LO) / CORE_STEP // 60
const LOW_COUNT = (CORE_LO - TAIL_LO) / TAIL_STEP // 10
const HIGH_COUNT = (TAIL_HI - CORE_HI) / TAIL_STEP // 20

export function newHistogram(): Float32Array {
  return new Float32Array(HIST_BINS)
}

/** Which bin a value falls in. Index 0 and `HIST_BINS - 1` are the catch-alls. */
export function binOf(x: number): number {
  if (x < TAIL_LO) return 0
  if (x >= TAIL_HI) return HIST_BINS - 1
  if (x < CORE_LO) return 1 + Math.floor((x - TAIL_LO) / TAIL_STEP)
  if (x < CORE_HI) return 1 + LOW_COUNT + Math.floor((x - CORE_LO) / CORE_STEP)
  return 1 + LOW_COUNT + CORE_COUNT + Math.floor((x - CORE_HI) / TAIL_STEP)
}

/** The half-open interval a bin covers. The catch-alls report a finite, honest width. */
export function binRange(i: number): [number, number] {
  if (i <= 0) return [TAIL_LO - TAIL_STEP, TAIL_LO]
  if (i >= HIST_BINS - 1) return [TAIL_HI, TAIL_HI + TAIL_STEP]
  if (i <= LOW_COUNT) return [TAIL_LO + (i - 1) * TAIL_STEP, TAIL_LO + i * TAIL_STEP]
  const j = i - 1 - LOW_COUNT
  if (j < CORE_COUNT) return [CORE_LO + j * CORE_STEP, CORE_LO + (j + 1) * CORE_STEP]
  const h = j - CORE_COUNT
  return [CORE_HI + h * TAIL_STEP, CORE_HI + (h + 1) * TAIL_STEP]
}

export function addToHistogram(h: Float32Array, x: number, weight = 1): void {
  h[binOf(x)] += weight
}

/** Ages a histogram, so its quantiles forget at the same rate the mean does. */
export function decayHistogram(h: Float32Array, days: number, halfLifeDays = DEFAULT_HALF_LIFE_DAYS): void {
  if (days <= 0) return
  const f = Math.pow(decayPerDay(halfLifeDays), days)
  for (let i = 0; i < h.length; i++) h[i] *= f
}

export function mergeHistogram(into: Float32Array, from: Float32Array, weight = 1): void {
  for (let i = 0; i < into.length; i++) into[i] += from[i] * weight
}

export function histogramTotal(h: Float32Array): number {
  let t = 0
  for (let i = 0; i < h.length; i++) t += h[i]
  return t
}

/**
 * A quantile, interpolated inside the bin it lands in.
 *
 * Returns null for an empty histogram rather than a plausible zero — a band that silently
 * becomes [0, 0] is worse than no band.
 */
export function quantile(h: Float32Array, q: number): number | null {
  const total = histogramTotal(h)
  if (total <= 0) return null

  const target = total * Math.min(1, Math.max(0, q))
  let cum = 0
  for (let i = 0; i < h.length; i++) {
    if (h[i] <= 0) continue
    if (cum + h[i] >= target) {
      const [lo, hi] = binRange(i)
      const within = (target - cum) / h[i]
      return lo + within * (hi - lo)
    }
    cum += h[i]
  }
  const [lo] = binRange(h.length - 1)
  return lo
}

/** Median absolute deviation from the median, scaled to compare with a standard deviation. */
export function robustScale(h: Float32Array): number {
  const p25 = quantile(h, 0.25)
  const p75 = quantile(h, 0.75)
  if (p25 === null || p75 === null) return 0
  // 1.349 is the interquartile range of a standard normal.
  return Math.max(0, (p75 - p25) / 1.349)
}

/**
 * Removes the known measurement noise from an observed spread.
 *
 * An increment is a difference of two observed times, so it carries *both* of their
 * errors: a 400 m Muni segment whose true increment varies by ten seconds is measured
 * with two ±15-second endpoints, and the observed spread is mostly instrumentation. Not
 * subtracting it means the band we publish is dominated by our own ignorance of when the
 * bus actually left, and the "where delay is made up" map renders a checkerboard of noise.
 */
export function deconvolve(observedVariance: number, noiseVariance: number): number {
  return Math.max(0, observedVariance - noiseVariance)
}
