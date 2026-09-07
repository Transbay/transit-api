import { Tier } from './observe.js'
import type { Deviation } from './deviation.js'
import { huberWeight, huberThreshold } from './stats.js'

/**
 * What the profile is allowed to learn from.
 *
 * Four layers, with genuinely different causes, so they get genuinely different treatment.
 * Collapsing them into one "is this an outlier" predicate is how a system ends up either
 * throwing away its most interesting data or averaging in its most misleading.
 *
 * 1. **Impossible.** A bus does not travel at 200 km/h and does not depart before it
 *    arrives. These are bugs — in the feed, in the matching, or in us — and they are
 *    counted and dropped, never softened.
 * 2. **Structurally different.** A cancelled trip, a skipped stop, an added special. Not a
 *    tail of the same distribution: a different population wearing the same key. Dropped
 *    by rule, not by robustness.
 * 3. **Genuine incidents.** A crash, a bridge lift, a police hold. Real, and the most
 *    interesting rows in the database — so they are kept whole in the histogram and merely
 *    down-weighted in the mean.
 * 4. **Whole-window anomalies.** A day the network stopped working. Recorded, flagged, and
 *    excluded from training, because one Bay Bridge closure otherwise argues about every
 *    Transbay segment for the next three weeks.
 */

export type Rejection =
  | 'impossible-deviation'
  | 'impossible-delta'
  | 'negative-dwell'
  | 'implausible-speed'
  | 'no-schedule'
  | 'trip-start'
  | 'untrusted-tier'
  | 'anomalous-window'
  | 'held-composite'

export interface Admission {
  /** Whether this may update a profile at all. */
  train: boolean
  /** Weight for the mean. 1 for an ordinary observation, lower for a suspected incident. */
  weight: number
  reason?: Rejection
}

/** Beyond this, a deviation is a matching failure rather than a late bus. */
export const MAX_DEVIATION = 7200

/** Beyond this, one segment did not do that. */
export const MAX_DELTA = 3600

/** Metres per second no surface mode in this region reaches. BART tops out near 31. */
export const MAX_SPEED = 40

/**
 * Layer 1 and 2: is this row a member of the population at all?
 *
 * Deliberately not parameterised by how confident the cell is. These are statements about
 * physics and about feed semantics, and they hold identically for a segment with four
 * observations and one with four thousand.
 */
export function admissible(d: Deviation, opts: { anomalousWindow?: boolean } = {}): Admission {
  if (opts.anomalousWindow) {
    return { train: false, weight: 0, reason: 'anomalous-window' }
  }
  if (d.tier === Tier.D) {
    return { train: false, weight: 0, reason: 'untrusted-tier' }
  }
  if (!Number.isFinite(d.devDeparture) || Math.abs(d.devDeparture) > MAX_DEVIATION) {
    return { train: false, weight: 0, reason: 'impossible-deviation' }
  }
  if (d.delta !== undefined && Math.abs(d.delta) > MAX_DELTA) {
    return { train: false, weight: 0, reason: 'impossible-delta' }
  }
  if (d.dwell !== undefined && d.dwell < 0) {
    return { train: false, weight: 0, reason: 'negative-dwell' }
  }
  if (d.segmentKey && d.delta !== undefined) {
    const elapsed = d.scheduledRun + d.delta
    if (elapsed <= 0) {
      // Zero or negative elapsed running time means the two observations are out of order.
      return { train: false, weight: 0, reason: 'implausible-speed' }
    }
  }
  if (!d.segmentKey) {
    // The first stop of a trip has no segment by nature, and that is not a fault. Counting
    // it as "no schedule" made a healthy pipeline look like a broken one, which matters:
    // the whole point of these counters is that somebody can tell the difference.
    return { train: false, weight: 0, reason: d.tripStart ? 'trip-start' : 'no-schedule' }
  }
  return { train: true, weight: 1 }
}

/**
 * Layer 3: how much of this observation the *mean* should feel.
 *
 * Two multipliers, and they answer different questions. The tier weight asks "how well do
 * we know this happened"; the Huber weight asks "how typical is it". A tier-A sighting of
 * a bus stuck behind a crash is known precisely and is still not what a Tuesday looks
 * like.
 */
export function trainingWeight(
  value: number,
  centre: number,
  cellScale: number,
  tierWeight: number,
): number {
  return tierWeight * huberWeight(value, centre, huberThreshold(cellScale))
}

// ---------------------------------------------------------------------------
// Layer 4: the whole window
// ---------------------------------------------------------------------------

export interface WindowSummary {
  agency: string
  /** Epoch seconds at the start of the hour. */
  hour: number
  observations: number
  medianDeviation: number
  activeTrips: number
}

export interface AnomalyVerdict {
  anomalous: boolean
  reason?: 'network-wide-delay' | 'service-collapse'
  detail?: string
}

/** Above this median lateness across a whole agency, something happened to the network. */
export const NETWORK_ANOMALY_SECONDS = 90

/** Below this fraction of the usual trip count, service is not running normally. */
export const SERVICE_COLLAPSE_RATIO = 0.6

/**
 * Whether a whole hour of an agency should be excluded from training.
 *
 * The comparison is against the same weekday's recent history, not against an all-time
 * average, because "fewer trips than a Tuesday" is meaningless on a Sunday.
 *
 * The rows are still written. This is not censorship of the record, it is a statement
 * that a network-wide event is not evidence about any individual segment — and the flagged
 * rows are the incident dataset, which is a thing worth having on its own.
 */
export function windowAnomaly(
  window: WindowSummary,
  typicalTripsForThisHour: number,
): AnomalyVerdict {
  if (Math.abs(window.medianDeviation) > NETWORK_ANOMALY_SECONDS && window.observations >= 30) {
    return {
      anomalous: true,
      reason: 'network-wide-delay',
      detail: `median ${Math.round(window.medianDeviation)}s across ${window.observations} observations`,
    }
  }
  if (
    typicalTripsForThisHour > 20 &&
    window.activeTrips < typicalTripsForThisHour * SERVICE_COLLAPSE_RATIO
  ) {
    return {
      anomalous: true,
      reason: 'service-collapse',
      detail: `${window.activeTrips} trips against a usual ${Math.round(typicalTripsForThisHour)}`,
    }
  }
  return { anomalous: false }
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * The fraction of scheduled trips we managed to observe end to end.
 *
 * Worth reporting on its own because the missing ones are not missing at random: a vehicle
 * stops reporting *because* something went wrong, so the observations we keep are
 * truncated on the late side. That biases every profile early, and no amount of careful
 * averaging inside the sample can detect it. At 85% it is a rounding error; at 55% with
 * the gaps skewing late, the profile is measuring the buses that had an easy day.
 */
export function coverage(observedTrips: number, scheduledTrips: number): number {
  if (scheduledTrips <= 0) return 0
  return Math.min(1, observedTrips / scheduledTrips)
}
