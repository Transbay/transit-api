/**
 * How *this* vehicle is running today, as distinct from how the route usually runs.
 *
 * The profile answers "what does this segment do to a typical bus at this hour". It says
 * nothing about the one that has been beating it by twenty-five seconds a stop since six
 * in the morning — a driver who runs hot, a light load, a vehicle in good order, an
 * operator taking the lights differently. That is a real, persistent, same-day effect, and
 * it is invisible to any amount of historical averaging.
 *
 * The quantity tracked is the **residual**: what this vehicle did minus what the profile
 * expected. Not the raw deviation. A bus running a genuinely slow corridor is late without
 * being slow, and keying on lateness would confuse the two — then project the corridor's
 * own congestion forward a second time on top of the profile that already contains it.
 */

export interface BlockState {
  /** Block where the operator publishes one, vehicle otherwise. See `blockKey`. */
  key: string
  serviceDate: string
  /** Exponentially weighted mean residual, seconds per segment. */
  residual: number
  /** Segments observed on this run today. Drives how much the residual is trusted. */
  observed: number
  /** The last deviation seen, for continuity across trips on the same block. */
  lastDev: number
  lastAt: number
  lastTripId: string
}

/** Weight of the newest residual in the EWMA. */
export const RESIDUAL_ALPHA = 0.3

/** Equivalent sample size of "this vehicle is ordinary". */
export const BLOCK_K = 4

/** No same-day term may move a prediction more than this. */
export const MAX_BLOCK_SECONDS = 180

/** A gap this long is a new run, usually a new operator. */
export const RUN_BREAK_SECONDS = 1800

/**
 * Which identity carries a driver's habits.
 *
 * `block_id` is the scheduling artefact that a driver stays with across trips, which makes
 * it the right key in principle. In practice a vehicle gets swapped mid-block often enough
 * to matter, and when the two disagree the *vehicle* is the better predictor — the effect
 * being measured is a combination of driver, vehicle and the traffic immediately around
 * it, and a paper block survives none of those.
 */
export function blockKey(vehicleId?: string, blockId?: string): string | null {
  return vehicleId || blockId || null
}

export function emptyBlockState(key: string, serviceDate: string, at: number): BlockState {
  return { key, serviceDate, residual: 0, observed: 0, lastDev: 0, lastAt: at, lastTripId: '' }
}

export interface BlockObservation {
  serviceDate: string
  tripId: string
  at: number
  /** Observed departure deviation at this stop. */
  dev: number
  /** Observed increment on the segment just completed. */
  delta: number
  /** What the profile expected that increment to be. */
  expected: number
}

/**
 * Folds one segment's outcome into the block's running bias.
 *
 * Resets rather than decays on a break, because a thirty-minute gap is not a quiet spell
 * in the same run — it is a layover with a relief driver, and carrying the previous
 * driver's bias across it is worse than starting from nothing.
 */
export function updateBlock(
  prior: BlockState | null,
  o: BlockObservation,
  key: string,
): BlockState {
  const broken =
    prior === null ||
    prior.key !== key ||
    prior.serviceDate !== o.serviceDate ||
    o.at - prior.lastAt > RUN_BREAK_SECONDS

  const base = broken ? emptyBlockState(key, o.serviceDate, o.at) : prior

  const residual = o.delta - o.expected
  return {
    key,
    serviceDate: o.serviceDate,
    residual: base.observed === 0 ? residual : (1 - RESIDUAL_ALPHA) * base.residual + RESIDUAL_ALPHA * residual,
    observed: base.observed + 1,
    lastDev: o.dev,
    lastAt: o.at,
    lastTripId: o.tripId,
  }
}

/**
 * How much of this vehicle's bias to carry forward over `segments` more segments.
 *
 * Shrunk by how much evidence today has actually produced — one segment is noise, eight
 * is a pattern — and capped in total, because the alternative is one anomalous segment
 * running away with a prediction twenty stops downstream.
 */
export function blockProjection(state: BlockState | null, segments: number): number {
  if (!state || state.observed === 0 || segments <= 0) return 0
  const lambda = state.observed / (state.observed + BLOCK_K)
  const raw = lambda * state.residual * segments
  return Math.max(-MAX_BLOCK_SECONDS, Math.min(MAX_BLOCK_SECONDS, raw))
}

/** How confident we are in the same-day term, for reporting rather than for arithmetic. */
export function blockConfidence(state: BlockState | null): number {
  if (!state) return 0
  return state.observed / (state.observed + BLOCK_K)
}

// ---------------------------------------------------------------------------
// Layovers
// ---------------------------------------------------------------------------

/**
 * What a delay arriving at a terminal becomes on the next trip.
 *
 * The most predictable thing in the whole system, and the one a naive model gets most
 * spectacularly wrong. A driver twelve minutes late into a terminal with a fifteen-minute
 * layover leaves the terminal *on time*: the schedule already contains the recovery. A
 * model that propagates delay across the trip boundary is confidently wrong on every
 * single block, every single day, and always in the same direction.
 *
 * `minTurn` is the part the schedule cannot absorb — the walk to the other end of the
 * train, the break the contract guarantees. Below it, lateness passes through.
 */
export function absorbLayover(
  arrivingDeviation: number,
  scheduledLayover: number,
  minTurn = 120,
): number {
  if (arrivingDeviation <= 0) {
    // Early into a terminal is simply early; the next trip still leaves on time.
    return 0
  }
  const absorbable = Math.max(0, scheduledLayover - minTurn)
  return Math.max(0, arrivingDeviation - absorbable)
}

// ---------------------------------------------------------------------------
// Bunching
// ---------------------------------------------------------------------------

/**
 * Whether a vehicle is being pushed around by the one in front of it.
 *
 * On frequent service the headway matters more than the timetable: a bus ten minutes late
 * on a six-minute headway is four minutes *behind* an on-time bus, picks up nobody, and
 * speeds up. The same ten minutes on an hourly route has no such channel — there is
 * nobody in front to have taken the passengers.
 *
 * Reported rather than folded into the prediction, for now. It is the natural next term in
 * the model and `docs/11-roadmap.md` says what it would take; putting an unvalidated
 * headway effect into a served number is exactly the kind of plausible-looking correction
 * this system is built to refuse.
 */
export function bunching(
  headwayScheduled: number,
  headwayObserved: number,
): { ratio: number; state: 'bunched' | 'gapped' | 'normal' | 'unknown' } {
  if (!(headwayScheduled > 0) || !(headwayObserved >= 0)) return { ratio: 1, state: 'unknown' }
  const ratio = headwayObserved / headwayScheduled
  if (ratio < 0.5) return { ratio, state: 'bunched' }
  if (ratio > 1.5) return { ratio, state: 'gapped' }
  return { ratio, state: 'normal' }
}

/** Frequent enough for headway to be the thing riders actually experience. */
export const FREQUENT_HEADWAY_SECONDS = 720
