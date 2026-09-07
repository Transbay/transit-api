import {
  type Moments,
  type Regression,
  emptyMoments,
  emptyRegression,
  observe,
  regress,
  decayTo,
  variance,
  shrink,
  shrinkVariance,
  shrunkVariance,
  fit,
  clampSlope,
  designEffect,
  effectiveN,
  newHistogram,
  addToHistogram,
  robustScale,
  quantile,
  deconvolve,
  HIST_BINS,
} from './stats.js'
import { asRate, fromRate, SEGMENT_MIN_RUN } from './schedule.js'
import { DayType, parentDayType, BUCKETS_PER_DAY } from './servicedate.js'

/**
 * The delay profile: what each segment does, by day type and time of day.
 *
 * The problem this file solves is that the natural key — segment, day type, half hour — is
 * far too fine to have data in. Five agencies have on the order of 25,000 segments; six day
 * types and sixty buckets each makes nine million cells, and a busy segment collects maybe
 * eighteen observations a week into any one of them. Most cells will never be able to speak
 * for themselves.
 *
 * So no cell speaks for itself. Every estimate is a blend of the cell and its parent, and
 * of that parent and *its* parent, all the way up to an agency-wide fallback that always
 * has data. A cell with no observations returns its parent exactly; a cell with hundreds
 * returns its own mean; in between it returns the weighted thing, and the weight is
 * `n / (n + k)` with a k estimated from how much the siblings actually differ rather than
 * chosen because it looked about right.
 *
 * Two details that are easy to get wrong and expensive to get wrong:
 *
 * - **The upper rungs are rates, not seconds.** Thirty seconds means something different
 *   on a nine-kilometre Transbay hop than on a two-hundred-metre downtown one, so a
 *   route-wide average in seconds is really an average of whichever segments happen to be
 *   longest. A ratio to scheduled running time is exchangeable between them and is what a
 *   fallback for an unseen segment actually needs.
 * - **Sample sizes are discounted.** Consecutive trips on a route share their causes, so
 *   the raw row count overstates the evidence — see `designEffect` in `stats.ts`.
 */

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

export interface Cell {
  /** Increment in seconds at segment level, as a rate at the pooled levels. */
  moments: Moments
  /** How the segment responds to a vehicle that is already late. */
  regression: Regression
  /** Kept only where tail *shape* is a property of the thing being measured. */
  histogram?: Float32Array
  /**
   * Scheduled running time this cell learned against.
   *
   * Stored so a timetable change can be *re-based* rather than forgotten: if the schedule
   * gives a segment thirty more seconds, every past observation's deviation shifts by
   * thirty seconds, and the corridor's actual behaviour is unchanged. Waiting three weeks
   * for exponential decay to forget a still-valid measurement is the wrong answer.
   */
  scheduledRun: number
  /** Mean measurement variance of the observations behind this cell, for deconvolution. */
  noiseVariance: number
}

export function emptyCell(scheduledRun = 0, at = 0): Cell {
  return {
    moments: emptyMoments(at),
    regression: emptyRegression(at),
    scheduledRun,
    noiseVariance: 0,
  }
}

export interface Observation {
  /** The increment, in seconds. */
  delta: number
  /** Deviation arriving at the segment, the regression's predictor. */
  priorDev?: number
  /** Scheduled running time of the segment this was measured on. */
  scheduledRun: number
  /** Combined tier and robustness weight. */
  weight: number
  /** Standard error of the observation, squared. */
  noiseVariance: number
  at: number
}

/** Folds one observation into a cell held in seconds (the segment rungs). */
export function updateSeconds(cell: Cell, o: Observation, keepHistogram: boolean): Cell {
  const moments = observe(cell.moments, o.delta, o.at, o.weight)
  const regression =
    o.priorDev === undefined
      ? cell.regression
      : regress(cell.regression, o.priorDev, o.delta, o.at, o.weight)

  let histogram = cell.histogram
  if (keepHistogram) {
    if (!histogram) histogram = newHistogram()
    addToHistogram(histogram, o.delta, o.weight)
  }

  // A running mean of the observation noise, so `spread` can be de-biased later.
  const total = moments.n
  const noiseVariance =
    total > 0 ? (cell.noiseVariance * cell.moments.n + o.noiseVariance * o.weight) / total : 0

  return {
    moments,
    regression,
    histogram,
    scheduledRun: o.scheduledRun || cell.scheduledRun,
    noiseVariance,
  }
}

/** Folds one observation into a cell held as a rate (the pooled rungs). */
export function updateRate(cell: Cell, o: Observation): Cell {
  const rate = asRate(o.delta, o.scheduledRun)
  return {
    moments: observe(cell.moments, rate, o.at, o.weight),
    regression: cell.regression,
    histogram: cell.histogram,
    scheduledRun: cell.scheduledRun,
    noiseVariance: cell.noiseVariance,
  }
}

/**
 * Re-bases a cell after the timetable moved under it.
 *
 * The observations are still true; what they were measured against changed. Shifting the
 * mean by the schedule's own change keeps the evidence and discounts it once, which is a
 * far better answer than either keeping a now-wrong mean or throwing away three weeks of
 * data because a planner added a minute of running time.
 */
export function rebase(cell: Cell, newScheduledRun: number, confidenceHaircut = 0.3): Cell {
  const shift = newScheduledRun - cell.scheduledRun
  if (cell.scheduledRun === 0 || shift === 0) {
    return { ...cell, scheduledRun: newScheduledRun }
  }
  return {
    moments: {
      ...cell.moments,
      mean: cell.moments.mean - shift,
      n: cell.moments.n * confidenceHaircut,
      m2: cell.moments.m2 * confidenceHaircut,
    },
    // The conditional response is about how the segment reacts, not about where the
    // timetable put it, but the fit is now mixing two baselines. Discount rather than keep.
    regression: { ...cell.regression, w: cell.regression.w * confidenceHaircut },
    histogram: undefined,
    scheduledRun: newScheduledRun,
    noiseVariance: cell.noiseVariance,
  }
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

export enum Level {
  /** segment, day type, half hour. The one everybody wants and almost nobody has. */
  SegmentDayBucket = 0,
  /** segment, day type. Where the tail shape lives. */
  SegmentDay = 1,
  /** segment, any day, any time. This segment's baseline. */
  Segment = 2,
  /** the same physical hop run by any route, by day type. */
  Corridor = 3,
  /** route and direction, by day type and half hour. Held as a rate. */
  RouteBucket = 4,
  /** route and direction. Held as a rate. */
  Route = 5,
  /** the agency, by day type and three-hour period. Always populated. */
  Agency = 6,
}

export const LEVEL_NAMES = [
  'segment x daytype x 30min',
  'segment x daytype',
  'segment',
  'corridor',
  'route x daytype x 30min',
  'route',
  'agency',
] as const

/** Levels held as a rate rather than as seconds. */
export function isRateLevel(level: Level): boolean {
  return level >= Level.Corridor
}

/**
 * Starting equivalent sample sizes.
 *
 * Replaced by `estimateK` against real siblings as soon as there is enough to estimate
 * from; these are what the system uses in week one. They are deliberately not equal: the
 * step from a half hour to a whole day type is a small one (adjacent half hours mostly
 * agree, so a cell needs real evidence to break away), while the step from a segment to a
 * route-wide rate is a large one (the segment genuinely knows better as soon as it knows
 * anything).
 */
export const DEFAULT_K: Record<Level, number> = {
  [Level.SegmentDayBucket]: 6,
  [Level.SegmentDay]: 8,
  [Level.Segment]: 10,
  [Level.Corridor]: 20,
  [Level.RouteBucket]: 25,
  [Level.Route]: 25,
  [Level.Agency]: 0,
}

/** Within-day correlation between consecutive trips. Measured per agency; this is a prior. */
export const DEFAULT_ICC = 0.5

export interface Estimate {
  /** Expected increment for this segment, in seconds. */
  delta: number
  /** Response to an already-late vehicle. Zero unless a segment rung had evidence. */
  slope: number
  /** Variance of this estimate. What the prediction fusion weights on. */
  variance: number
  /** Variance of a single future observation. What the band is drawn from. */
  spread: number
  /** Effective sample size at the finest rung that contributed. */
  n: number
  /** The finest rung that carried more than half its own weight. */
  level: Level
  /** True when nothing but the agency fallback had anything to say. */
  fallback: boolean
}

export interface LadderInput {
  /** The cells, coarse to fine. Missing rungs are simply absent. */
  cells: Partial<Record<Level, Cell>>
  scheduledRun: number
  /** Per-level k, defaulting to `DEFAULT_K`. */
  k?: Partial<Record<Level, number>>
  icc?: number
  /** Observations per cluster, for the design effect. */
  perCluster?: number
  now?: number
  /**
   * A slope from somewhere other than a live regression.
   *
   * The packed hot-path form carries the fitted number rather than the five accumulators
   * behind it, because storing the accumulators would double the blob for something only
   * the aggregator ever refits.
   */
  slope?: number
}

/**
 * Walks the ladder from the agency fallback down to the finest cell that has evidence.
 *
 * Coarse to fine, because that is the direction the information actually flows: each rung
 * is a prior for the next, and the finest rung with data ends up dominating exactly to the
 * extent that it has earned it.
 */
export function estimate(input: LadderInput): Estimate {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const scheduledRun = Math.max(SEGMENT_MIN_RUN, input.scheduledRun)
  const icc = input.icc ?? DEFAULT_ICC
  const deff = designEffect(input.perCluster ?? 4, icc)

  let theta = 0
  let spread = 3600 // 60 s of standard deviation, before anything is known
  let touched = false
  const contributions: { level: Level; weight: number; n: number }[] = []

  // Coarse to fine, because that is the direction information flows: each rung is the
  // prior for the next.
  for (let level = Level.Agency; level >= Level.SegmentDayBucket; level--) {
    const cell = input.cells[level as Level]
    if (!cell || cell.moments.n <= 0) continue

    const aged = decayTo(cell.moments, now)
    const n = effectiveN(aged.n, deff)
    if (n <= 0) continue
    touched = true

    const mean = isRateLevel(level) ? fromRate(aged.mean, scheduledRun) : aged.mean
    const rawVar = isRateLevel(level)
      ? variance(aged) * scheduledRun * scheduledRun
      : variance(aged)

    const k = input.k?.[level as Level] ?? DEFAULT_K[level as Level]
    theta = shrink(n, mean, k, theta)
    spread = shrinkVariance(n, deconvolve(rawVar, cell.noiseVariance), 8, spread)

    contributions.push({ level: level as Level, weight: n / (n + Math.max(1e-9, k)), n })
  }

  // Which rung actually carried the answer.
  //
  // Not simply "the largest n / (n + k)", because the root rung has no parent to be
  // shrunk toward — its k is zero, so that ratio is always exactly 1 and the root would
  // always be reported as the source however much better-informed the segment was. The
  // question being asked is "which is the finest rung that spoke for itself", so ask that.
  const candidates = contributions.filter((c) => c.level !== Level.Agency)
  const spoke = candidates.filter((c) => c.weight >= 0.5).sort((a, b) => a.level - b.level)[0]
  const loudest = candidates.sort((a, b) => b.weight - a.weight)[0]
  const winner = spoke ?? loudest
  const bestLevel = winner?.level ?? Level.Agency
  const leafN = winner?.n ?? contributions.find((c) => c.level === Level.Agency)?.n ?? 0

  // The conditional response comes from the finest segment-level rung that has one; a
  // route-wide slope would apply an express corridor's recovery to a local stop pair.
  let slope = input.slope === undefined ? 0 : clampSlope(input.slope)
  for (const level of [Level.SegmentDayBucket, Level.SegmentDay, Level.Segment]) {
    const cell = input.cells[level]
    if (!cell) continue
    const f = fit(cell.regression)
    if (f.n >= 8) {
      slope = clampSlope(f.slope)
      break
    }
  }

  return {
    delta: theta,
    slope,
    variance: shrunkVariance(leafN, spread, DEFAULT_K[bestLevel]),
    spread,
    n: leafN,
    level: bestLevel,
    fallback: !touched || bestLevel === Level.Agency,
  }
}

/**
 * Pools a bucket with its neighbours before the ladder sees it.
 *
 * Hard half-hour edges produce a visible discontinuity — a departure estimate that jumps
 * forty seconds as the clock ticks past `:30`, for no reason a rider could ever be told.
 * Traffic does not work like that, and neither should the model. A triangular kernel over
 * three buckets removes the edge and roughly triples the evidence behind each estimate,
 * for one loop.
 */
export function smoothBuckets(
  byBucket: Map<number, Cell>,
  bucket: number,
  weights: [number, number, number] = [0.5, 1, 0.5],
): Cell | undefined {
  const parts: { cell: Cell; w: number }[] = []
  for (let i = -1; i <= 1; i++) {
    const b = bucket + i
    if (b < 0 || b >= BUCKETS_PER_DAY) continue
    const cell = byBucket.get(b)
    if (cell && cell.moments.n > 0) parts.push({ cell, w: weights[i + 1] })
  }
  if (parts.length === 0) return undefined
  if (parts.length === 1 && parts[0].w === 1) return parts[0].cell

  let n = 0
  let mean = 0
  let scheduledRun = 0
  let noiseVariance = 0
  for (const { cell, w } of parts) {
    const wn = cell.moments.n * w
    n += wn
    mean += cell.moments.mean * wn
    scheduledRun = Math.max(scheduledRun, cell.scheduledRun)
    noiseVariance += cell.noiseVariance * wn
  }
  if (n <= 0) return undefined
  mean /= n
  noiseVariance /= n

  let m2 = 0
  for (const { cell, w } of parts) {
    const wn = cell.moments.n * w
    m2 += cell.moments.m2 * w + wn * (cell.moments.mean - mean) ** 2
  }

  const updatedAt = Math.max(...parts.map((p) => p.cell.moments.updatedAt))
  return {
    moments: { n, mean, m2, updatedAt },
    // The regression stays the centre bucket's own; blending slopes across time of day
    // mixes a peak-hour response with an off-peak one.
    regression: byBucket.get(bucket)?.regression ?? emptyRegression(updatedAt),
    scheduledRun,
    noiseVariance,
  }
}

/** Which day types a thin cell may borrow from, finest first. */
export function dayTypeChain(dt: DayType): DayType[] {
  const chain = [dt]
  let cur: DayType | null = dt
  while ((cur = parentDayType(cur)) !== null) chain.push(cur)
  return chain
}

// ---------------------------------------------------------------------------
// The packed form
// ---------------------------------------------------------------------------

/**
 * One route-direction-daytype's segments, as a single binary value.
 *
 * The obvious storage — one Redis hash field per cell — costs about 110 bytes of Redis
 * overhead *per field*, which across four and a half million populated cells is around
 * half a gigabyte of key metadata for forty megabytes of numbers. Packing a whole route
 * into one value is roughly ten times cheaper and, more usefully, means predicting a whole
 * trip is one `HGET` rather than forty.
 *
 * Only what the hot path reads is here. Histograms and the full moment structures stay in
 * Postgres, where the analysis pages can afford them.
 */
export const BLOB_VERSION = 2

/** Marks a bucket with no data, distinguishable from a bucket whose mean is zero. */
const EMPTY = -32768

const PER_BUCKET = 4
const SEGMENT_FIXED = 10

export interface PackedSegment {
  /** `fromStopId>toStopId` with an occurrence suffix where the route loops. */
  key: string
  scheduledRun: number
  slope: number
  /** Mean increment for the segment overall, seconds. */
  meanAll: number
  /** Standard deviation of a single observation, seconds. */
  sdAll: number
  nAll: number
  /** Per-bucket mean in seconds, sd in seconds, and effective count. */
  buckets: (null | { mean: number; sd: number; n: number })[]
}

export function packProfile(segments: PackedSegment[]): Buffer {
  const chunks: Buffer[] = []
  const header = Buffer.alloc(3)
  header.writeUInt8(BLOB_VERSION, 0)
  header.writeUInt16LE(segments.length, 1)
  chunks.push(header)

  for (const s of segments) {
    const key = Buffer.from(s.key, 'utf8')
    const fixed = Buffer.alloc(2 + key.length + SEGMENT_FIXED + BUCKETS_PER_DAY * PER_BUCKET)
    let o = 0
    fixed.writeUInt16LE(key.length, o)
    o += 2
    key.copy(fixed, o)
    o += key.length

    fixed.writeUInt16LE(clampU16(s.scheduledRun), o)
    o += 2
    fixed.writeInt16LE(clampI16(Math.round(s.slope * 1000)), o)
    o += 2
    fixed.writeInt16LE(clampI16(Math.round(s.meanAll)), o)
    o += 2
    fixed.writeUInt16LE(clampU16(Math.round(s.nAll)), o)
    o += 2
    fixed.writeUInt16LE(clampU16(Math.round(s.sdAll)), o)
    o += 2

    for (let b = 0; b < BUCKETS_PER_DAY; b++) {
      const cell = s.buckets[b]
      if (!cell) {
        fixed.writeInt16LE(EMPTY, o)
        fixed.writeUInt8(0, o + 2)
        fixed.writeUInt8(0, o + 3)
      } else {
        fixed.writeInt16LE(clampI16(Math.round(cell.mean)), o)
        fixed.writeUInt8(clampU8(Math.round(cell.n)), o + 2)
        // Quarter-second resolution on a standard deviation is far finer than the
        // uncertainty in it, and it buys a byte per bucket across millions of them.
        fixed.writeUInt8(clampU8(Math.round(cell.sd / 4)), o + 3)
      }
      o += PER_BUCKET
    }

    chunks.push(fixed)
  }

  return Buffer.concat(chunks)
}

export function unpackProfile(buf: Buffer): Map<string, PackedSegment> {
  const out = new Map<string, PackedSegment>()
  if (buf.length < 3) return out
  const version = buf.readUInt8(0)
  // A blob written by an older build is discarded rather than misread; the aggregator
  // rewrites everything within one cycle, so the cost of a version bump is minutes.
  if (version !== BLOB_VERSION) return out

  const count = buf.readUInt16LE(1)
  const bucketBytes = BUCKETS_PER_DAY * PER_BUCKET
  let o = 3

  for (let i = 0; i < count && o + 2 <= buf.length; i++) {
    const keyLen = buf.readUInt16LE(o)
    o += 2
    // A blob can arrive short -- a partial write, a truncated read, a value clipped by a
    // proxy. Stopping at the last whole segment gives a usable profile; reading past the
    // end throws inside a poll cycle, which is a much worse answer than a shorter profile.
    if (o + keyLen + SEGMENT_FIXED + bucketBytes > buf.length) break
    const key = buf.subarray(o, o + keyLen).toString('utf8')
    o += keyLen

    const scheduledRun = buf.readUInt16LE(o)
    const slope = buf.readInt16LE(o + 2) / 1000
    const meanAll = buf.readInt16LE(o + 4)
    const nAll = buf.readUInt16LE(o + 6)
    const sdAll = buf.readUInt16LE(o + 8)
    o += SEGMENT_FIXED

    const buckets: PackedSegment['buckets'] = []
    for (let b = 0; b < BUCKETS_PER_DAY; b++) {
      const mean = buf.readInt16LE(o)
      const n = buf.readUInt8(o + 2)
      const sd = buf.readUInt8(o + 3) * 4
      buckets.push(mean === EMPTY ? null : { mean, sd, n })
      o += PER_BUCKET
    }

    out.set(key, { key, scheduledRun, slope, meanAll, sdAll, nAll, buckets })
  }

  return out
}

function clampI16(v: number): number {
  return Math.min(32767, Math.max(-32767, v | 0))
}
function clampU16(v: number): number {
  return Math.min(65535, Math.max(0, v | 0))
}
function clampU8(v: number): number {
  return Math.min(255, Math.max(0, v | 0))
}

/** Turns a packed segment back into the ladder's input for one bucket. */
export function fromPacked(
  packed: PackedSegment,
  bucket: number,
  now: number,
): LadderInput {
  const cells: Partial<Record<Level, Cell>> = {}

  const b = packed.buckets[bucket]
  if (b && b.n > 0) {
    cells[Level.SegmentDayBucket] = {
      moments: { n: b.n, mean: b.mean, m2: b.sd * b.sd * b.n, updatedAt: now },
      regression: emptyRegression(now),
      scheduledRun: packed.scheduledRun,
      noiseVariance: 0,
    }
  }
  if (packed.nAll > 0) {
    cells[Level.Segment] = {
      moments: {
        n: packed.nAll,
        mean: packed.meanAll,
        m2: packed.sdAll * packed.sdAll * packed.nAll,
        updatedAt: now,
      },
      regression: emptyRegression(now),
      scheduledRun: packed.scheduledRun,
      noiseVariance: 0,
    }
  }

  return { cells, scheduledRun: packed.scheduledRun, now, slope: packed.slope }
}

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

/**
 * A prediction interval from a histogram where one exists, and from a normal
 * approximation where one does not.
 *
 * The distinction matters at the top end. Delay is right-skewed — buses are occasionally
 * very late and never very early — so a symmetric band drawn from a standard deviation
 * puts its upper edge in the wrong place and its lower edge somewhere impossible.
 */
export function band(
  centre: number,
  spreadVariance: number,
  histogram: Float32Array | undefined,
  quantiles: [number, number] = [0.1, 0.9],
): { low: number; high: number; fromHistogram: boolean } {
  if (histogram) {
    const lo = quantile(histogram, quantiles[0])
    const hi = quantile(histogram, quantiles[1])
    if (lo !== null && hi !== null) {
      // The histogram carries the *shape*; the ladder carries where the centre is. Shift
      // rather than replace, so a thin cell borrowing its parent's tail still sits where
      // its own evidence puts it.
      const median = quantile(histogram, 0.5) ?? 0
      return { low: centre + (lo - median), high: centre + (hi - median), fromHistogram: true }
    }
  }
  const sd = Math.sqrt(Math.max(0, spreadVariance))
  // 1.2816 is the 90th percentile of a standard normal.
  return { low: centre - 1.2816 * sd, high: centre + 1.2816 * sd, fromHistogram: false }
}

export { HIST_BINS, robustScale }
