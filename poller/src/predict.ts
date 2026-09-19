import type { TripSchedule } from './schedule.js'
import { epochSecondsFor } from './servicedate.js'
import { Level, band, type Estimate } from './profile.js'
import { blockProjection, type BlockState } from './blockstate.js'
import { DEFAULT_HOLD_OFFSET, HOLD_RATE_THRESHOLD, MIN_HOLD_EVIDENCE } from './deviation.js'

/**
 * Turning what we have learned into a time.
 *
 * Three estimators, each with its own idea of when the vehicle will arrive and — this is
 * the part that matters — its own honest uncertainty. They are combined by inverse-variance
 * weighting, which is the right combination for approximately independent estimators, needs
 * no tuned weights, and is self-correcting: an estimator whose history says it is unreliable
 * in this context automatically stops mattering, without anybody having to notice and turn
 * it down.
 *
 * Then the clamps. Every one of them exists because the unclamped version produces a number
 * that is arithmetically defensible and obviously wrong to anybody standing at the stop.
 */

// ---------------------------------------------------------------------------
// Estimators
// ---------------------------------------------------------------------------

export interface Estimator {
  name: 'profile' | 'agency' | 'block'
  /** Epoch seconds. */
  time: number
  /** Variance of *this estimate*, not of a single observation. */
  variance: number
}

export interface FusedEstimate {
  time: number
  variance: number
  weights: { name: Estimator['name']; weight: number }[]
}

/**
 * Precision-weighted combination.
 *
 * Note what this does when one estimator is far more certain than the others: it wins,
 * almost completely, which is correct. And note what it does when they disagree: nothing.
 * Disagreement is not represented in the output variance, which is a known limitation of
 * inverse-variance pooling and the reason `disagreement` is reported separately below.
 */
export function fuse(estimators: Estimator[]): FusedEstimate | null {
  const usable = estimators.filter((e) => Number.isFinite(e.time) && e.variance > 0)
  if (usable.length === 0) return null

  let sumPrecision = 0
  let sumWeighted = 0
  for (const e of usable) {
    const p = 1 / e.variance
    sumPrecision += p
    sumWeighted += e.time * p
  }

  return {
    time: sumWeighted / sumPrecision,
    variance: 1 / sumPrecision,
    weights: usable.map((e) => ({ name: e.name, weight: 1 / e.variance / sumPrecision })),
  }
}

/**
 * How far apart the estimators are, in seconds.
 *
 * Large disagreement with a small fused variance is the signature of a model about to be
 * confidently wrong, and it is invisible in the fused number itself. Surfaced so the
 * confidence gate can refuse to claim much when the estimators cannot agree.
 */
export function disagreement(estimators: Estimator[]): number {
  const times = estimators.filter((e) => Number.isFinite(e.time)).map((e) => e.time)
  if (times.length < 2) return 0
  return Math.max(...times) - Math.min(...times)
}

// ---------------------------------------------------------------------------
// Propagation
// ---------------------------------------------------------------------------

/**
 * Correlation between the increments of adjacent segments.
 *
 * They are not independent — a jam spans several stops, rain covers a whole route — so
 * summing their variances understates the uncertainty of a long propagation. The variance
 * of a sum of m equicorrelated terms is `m·sigma^2·(1 + (m-1)·rho)`, and without the second
 * factor a twenty-stop propagation would claim a precision it does not have.
 */
export const SEGMENT_CORRELATION = 0.3

export interface PropagationStep {
  /** Index into `trip.stops` of the stop being reached. */
  index: number
  expected: number
  slope: number
  variance: number
  timepoint: boolean
  scheduledDeparture: number
  n: number
  level: Level
}

export interface PropagationResult {
  /** Predicted departure deviation at the target, in seconds. */
  deviation: number
  variance: number
  /** How much of the total came from each source. */
  basis: { profile: number; block: number; hold: number }
  steps: number
  /** The finest ladder rung any step managed to use. */
  bestLevel: Level
  /** Smallest effective sample size along the path — the weakest link. */
  minN: number
  heldAt: number[]
}

/**
 * Walks a trip forward from a known deviation.
 *
 * `d_k = d_{k-1} + alpha_k + beta_k * d_{k-1}`, which is an AR(1) rather than a random
 * walk. That distinction is the difference between a model that settles and one that
 * diverges: summing average increments over twenty stops compounds them, while a negative
 * beta pulls toward an equilibrium the way schedule slack actually does.
 */
export function propagate(
  trip: TripSchedule,
  serviceDate: string,
  fromIndex: number,
  toIndex: number,
  startDeviation: number,
  profileFor: (index: number) => Estimate,
  block: BlockState | null,
  holdOffset = DEFAULT_HOLD_OFFSET,
): PropagationResult {
  let d = startDeviation
  let naiveVariance = 0
  let profileContribution = 0
  let holdContribution = 0
  let bestLevel = Level.Agency
  let minN = Number.POSITIVE_INFINITY
  const heldAt: number[] = []
  let steps = 0

  // From the first real segment. With no anchor `fromIndex` is -1, and "the segment into
  // stop 0" does not exist: it has no evidence, so walking it pinned `minN` to 0 and every
  // unanchored prediction fell back to the agency's number without anyone noticing.
  for (let k = Math.max(fromIndex + 1, 1); k <= toIndex && k < trip.stops.length; k++) {
    const est = profileFor(k)
    const before = d
    d = d + est.delta + est.slope * d
    profileContribution += d - before

    naiveVariance += est.variance
    if (est.level < bestLevel) bestLevel = est.level
    minN = Math.min(minN, est.n)
    steps++

    // A vehicle running early into a stop that holds waits there. Predicting its early
    // arrival as an early *departure* is how a rider is told the bus is at the platform
    // when it left four minutes ago -- the single most common way a delay model produces a
    // number that is confidently, repeatably wrong.
    //
    // Which stops hold is *measured*, and only falls back to the timetable's flag while
    // there is not enough evidence yet. Some stops on a route hold and some do not, and no
    // flag in the feed distinguishes them: `timepoint = 1` marks a published time, not a
    // promise that anybody waits for it.
    const holds = holdsMeasured({ rate: est.holdRate, n: est.holdN })
    if (holds && d < holdOffset) {
      holdContribution += holdOffset - d
      d = holdOffset
      heldAt.push(k)
    }
  }

  const blockTerm = blockProjection(block, steps)
  d += blockTerm

  const inflation = steps > 1 ? 1 + (steps - 1) * SEGMENT_CORRELATION : 1

  return {
    deviation: d,
    variance: naiveVariance * inflation,
    basis: { profile: profileContribution, block: blockTerm, hold: holdContribution },
    steps,
    bestLevel,
    minN: Number.isFinite(minN) ? minN : 0,
    heldAt,
  }
}

// ---------------------------------------------------------------------------
// The whole prediction
// ---------------------------------------------------------------------------

export type Confidence = 'none' | 'low' | 'medium' | 'high'

export interface AgencyErrorProfile {
  /** Mean signed error of the agency's prediction at this horizon, seconds. */
  mean: number
  variance: number
  n: number
}

export interface PredictInput {
  trip: TripSchedule
  serviceDate: string
  now: number
  /** Index into `trip.stops` of the stop being predicted. */
  target: number
  /** The last stop confirmed passed, and the departure deviation observed there. */
  anchor?: { index: number; deviation: number; at: number }
  /** The agency's own predicted time for the target, epoch seconds. */
  agencyPrediction?: number
  /** Measured correction for the agency's prediction at this horizon, if trusted. */
  agencyError?: AgencyErrorProfile
  /** Ladder estimate for the segment ending at each stop index. */
  profileFor: (index: number) => Estimate
  block?: BlockState | null
  /** Distribution of increments on this segment, for an asymmetric band. */
  histogram?: Float32Array
  /** How late this operator typically leaves its origin, for a trip that has not started. */
  startProfile?: AgencyErrorProfile
  holdOffset?: number
  /** Below this many effective samples, the profile estimator is not offered at all. */
  minSamples?: number
  /** Measured hold behaviour at the target stop itself, where the caller has it. */
  targetHold?: { rate: number; n: number } | null
}

export interface Prediction {
  /** Epoch seconds. */
  time: number
  /** What the agency said, unchanged. Always present when the agency said anything. */
  raw?: number
  correctionSeconds: number
  low: number
  high: number
  confidence: Confidence
  basis: {
    schedule: number
    profile: number
    block: number
    hold: number
    agencyError: number
  }
  estimators: { name: string; time: number; weight: number }[]
  clamps: string[]
  n: number
  level: Level
  disagreementSeconds: number
}

/** The furthest a correction may move a prediction without exceptional evidence. */
export function correctionCap(horizonSeconds: number): number {
  return Math.max(90, 0.25 * Math.max(0, horizonSeconds))
}

/**
 * Shrinks a correction toward zero rather than capping it.
 *
 * A hard cap produces a visible jump in the served number the instant a cell crosses a
 * sample threshold — the same bus, the same second, a ninety-second change because one
 * more observation arrived. Continuous shrinkage does the same job without the step.
 */
export function temper(correction: number, n: number, k = 15): number {
  return correction * (n / (n + k))
}

/**
 * Whether to predict a hold here: only where early vehicles have been *seen* waiting.
 *
 * Deliberately not the timetable's `timepoint` flag as a fallback, which is what the
 * learning side uses to interpret what it saw. Predicting forward, the flag's error is the
 * expensive one: it moved a Muni 1 running four and a half minutes early back to its
 * timetable at California & Presidio -- five minutes later than it arrived -- because the
 * stop is flagged and nobody had measured whether drivers wait there. A late prediction
 * for an early bus is a missed bus. Without evidence, trust where the vehicle is.
 */
export function holdsMeasured(measured: { rate?: number; n?: number } | null | undefined): boolean {
  return Boolean(
    measured &&
      (measured.n ?? 0) >= MIN_HOLD_EVIDENCE &&
      (measured.rate ?? 0) >= HOLD_RATE_THRESHOLD,
  )
}

export function predict(input: PredictInput): Prediction | null {
  const { trip, target, now } = input
  const stop = trip.stops[target]
  if (!stop) return null

  const holdOffset = input.holdOffset ?? DEFAULT_HOLD_OFFSET
  const minSamples = input.minSamples ?? 3
  const scheduled = epochSecondsFor(input.serviceDate, stop.departure)
  const clamps: string[] = []

  // --- estimator 1: schedule plus what the segments do --------------------
  const anchor = input.anchor
  const startIndex = anchor?.index ?? -1
  const startDeviation = anchor?.deviation ?? input.startProfile?.mean ?? 0
  if (!anchor && input.startProfile) clamps.push('start-profile')

  const prop = propagate(
    trip,
    input.serviceDate,
    startIndex,
    target,
    startDeviation,
    input.profileFor,
    input.block ?? null,
    holdOffset,
  )

  const estimators: Estimator[] = []

  if (prop.minN >= minSamples || prop.steps === 0) {
    estimators.push({
      name: 'profile',
      time: scheduled + prop.deviation,
      // A trip that has not started carries the start profile's uncertainty as well.
      variance: prop.variance + (anchor ? 0 : (input.startProfile?.variance ?? 3600)),
    })
  }

  // --- estimator 2: the agency's prediction, corrected --------------------
  const raw = input.agencyPrediction
  if (raw !== undefined) {
    const err = input.agencyError
    // The agency's own number, uncorrected, is always an estimator. Its variance is the
    // measured spread of its errors at this horizon where we have one, and a deliberately
    // pessimistic default where we do not -- so an unmeasured agency does not silently
    // dominate the fusion.
    estimators.push({
      name: 'agency',
      time: raw + (err && err.n >= 20 ? err.mean : 0),
      variance: err && err.n >= 20 ? Math.max(100, err.variance) : 40_000,
    })
  }

  // --- estimator 3: nothing but this vehicle's own pace -------------------
  if (anchor && input.block && input.block.observed >= 2) {
    const scheduledFromAnchor = epochSecondsFor(input.serviceDate, trip.stops[anchor.index].departure)
    const elapsedScheduled = stop.departure - trip.stops[anchor.index].departure
    estimators.push({
      name: 'block',
      time: scheduledFromAnchor + elapsedScheduled + anchor.deviation + blockProjection(input.block, prop.steps),
      // Weak on purpose. This is a single vehicle's recent behaviour with no history
      // behind it, and it exists to stop a thin profile being the only voice in the room.
      variance: 90_000,
    })
  }

  const fused = fuse(estimators)
  if (!fused) return null

  // The evidence behind each estimator, in its own terms: segments walked for the profile,
  // measured errors for the agency's bias, segments seen today for the block.
  const evidenceOf = (name: Estimator['name']): number =>
    name === 'profile'
      ? prop.minN
      : name === 'agency'
        ? input.agencyError && input.agencyError.n >= 20 ? input.agencyError.n : 0
        : (input.block?.observed ?? 0)
  const weightOf = (name: Estimator['name']) =>
    fused.weights.find((w) => w.name === name)?.weight ?? 0
  /** The fused estimate's evidence: each estimator's, weighted by how much it counted. */
  const nEff = estimators.reduce((sum, e) => sum + weightOf(e.name) * evidenceOf(e.name), 0)

  // --- clamps -------------------------------------------------------------
  let time = fused.time

  const correctionBefore = raw === undefined ? 0 : time - raw
  if (raw !== undefined) {
    const cap = correctionCap(raw - now)
    // Each estimator's pull is shrunk by its own evidence. Tempering the whole correction
    // by the profile's count shrank a well-measured agency bias -- Muni allowing the N a
    // minute too long, seen hundreds of times -- to a few seconds whenever the segments
    // on the way were thin.
    const tempered = estimators.reduce(
      (sum, e) => sum + weightOf(e.name) * temper(e.time - raw, evidenceOf(e.name)),
      0,
    )
    if (Math.abs(tempered) < Math.abs(correctionBefore)) clamps.push('tempered')
    let applied = tempered
    if (Math.abs(applied) > cap) {
      applied = Math.sign(applied) * cap
      clamps.push('capped')
    }
    time = raw + applied
  }

  // Never before the vehicle could physically be here. Where we know the anchor, the
  // earliest possible time is "left the last confirmed stop now and ran the scheduled
  // time"; a prediction earlier than that describes a bus that has already gone past.
  if (anchor) {
    const remaining = stop.departure - trip.stops[anchor.index].departure
    const earliest = anchor.at + Math.max(0, remaining) * 0.5
    if (time < earliest) {
      time = earliest
      clamps.push('unreachable')
    }
  }

  // A held stop cannot be predicted before its published time. Same precedence: what has
  // been observed at this stop beats what the timetable says about it.
  const targetHolds = holdsMeasured(input.targetHold ?? input.profileFor(target))
  if (targetHolds && time < scheduled + holdOffset) {
    time = scheduled + holdOffset
    clamps.push('timepoint-hold')
  }

  // Nothing in the past.
  if (time < now) {
    time = now
    clamps.push('past')
  }

  const spread = Math.max(fused.variance, prop.variance / Math.max(1, prop.steps))
  const b = band(0, spread, input.histogram)

  const disagreementSeconds = disagreement(estimators)
  const confidence = confidenceOf({
    n: nEff,
    level: prop.bestLevel,
    estimators: estimators.length,
    disagreementSeconds,
    hasAgency: raw !== undefined,
  })

  return {
    time: Math.round(time),
    raw,
    correctionSeconds: raw === undefined ? 0 : Math.round(time - raw),
    low: Math.round(time + b.low),
    high: Math.round(time + b.high),
    confidence,
    basis: {
      schedule: Math.round(scheduled),
      profile: Math.round(prop.basis.profile),
      block: Math.round(prop.basis.block),
      hold: Math.round(prop.basis.hold),
      agencyError: Math.round(input.agencyError?.mean ?? 0),
    },
    estimators: fused.weights.map((w) => ({
      name: w.name,
      time: Math.round(estimators.find((e) => e.name === w.name)!.time),
      weight: Number(w.weight.toFixed(3)),
    })),
    clamps,
    n: Math.round(nEff * 10) / 10,
    level: prop.bestLevel,
    disagreementSeconds: Math.round(disagreementSeconds),
  }
}

/**
 * What we are willing to claim.
 *
 * Deliberately conservative, and deliberately not a function of how large the correction
 * is: a big correction backed by four hundred observations is more trustworthy than a
 * small one backed by four. What downgrades confidence is thin evidence, a coarse ladder
 * rung, or estimators that cannot agree with each other.
 */
export function confidenceOf(x: {
  n: number
  level: Level
  estimators: number
  disagreementSeconds: number
  hasAgency: boolean
}): Confidence {
  if (x.n < 3 || x.level >= Level.Route) return 'none'
  if (x.disagreementSeconds > 600) return 'low'
  if (x.n >= 30 && x.level <= Level.SegmentDay && x.disagreementSeconds < 180) return 'high'
  if (x.n >= 10 && x.level <= Level.Segment) return 'medium'
  return 'low'
}
