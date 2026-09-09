import type { TripUpdateRecord } from './observe.js'
import { bucketOf, serviceSecondsOf, dayTypeOf, type DayType, type ServiceDate } from './servicedate.js'

/**
 * How an agency's own prediction moves as the arrival closes.
 *
 * A rider watching a BART platform sign sees the countdown hold at "2 min", then jump
 * twenty seconds later in the final half minute before the train actually arrives. That is
 * not traffic — traffic is what `profile.ts` learns. It is an artefact of the producer:
 * its estimate converges on the truth from a predictable direction, at a predictable
 * point, and it does so the same way every weekday.
 *
 * Which means it can be known in advance. This module measures it.
 *
 * ## Why this is separate from the segment profile
 *
 * `profile.ts` learns `actual - scheduled` per segment: where a route loses time and where
 * it gets it back. That model is blind to this effect by construction — it never looks at
 * what the agency *said*, only at what the vehicle *did*, so a producer that is reliably
 * 20 seconds optimistic at short horizons is invisible to it.
 *
 * This is the complementary measurement: `predFinal - predAtHorizon`, keyed by how far out
 * the prediction was made.
 *
 * ## Why it can cover every agency
 *
 * It needs no schedule. No `stop_times`, no calendar, no Postgres trip index, and no
 * observation pipeline — only the trip-update stream, which `rtdecode.decodeTripUpdates`
 * already hands over for every operator the regional feed carries when passed a `null`
 * agency filter.
 *
 * That matters because the segment profile is expensive per agency and is therefore
 * limited to five. This is cheap per agency and is limited to none. Every operator on the
 * map gets it.
 *
 * ## The honest caveat
 *
 * The reference point here is the agency's *own last word*, not a measured passage time.
 * So this cannot say whether a producer is accurate — grading a predictor against itself
 * measures how fast it converges, not whether it converged on the right answer, and
 * `docs/03-observation.md` is right to warn about exactly that.
 *
 * It is valid for what it is used for: how much the number moves, and when. Where real
 * observations exist, `prediction_error` also carries the measured `actual - predicted`,
 * and the two should agree. If they ever disagree, this measurement is the one to distrust.
 */

/**
 * Upper edges, in seconds, of the horizon buckets. Seven buckets, deliberately fine near
 * arrival: the whole effect lives in the last two minutes, and a model that lumps
 * "0-5 minutes" together averages the jump away with the flat part before it.
 */
export const HORIZON_EDGES = [30, 60, 120, 300, 600, 1200] as const
export const HORIZON_BUCKETS = HORIZON_EDGES.length + 1

export function horizonBucket(seconds: number): number {
  for (let i = 0; i < HORIZON_EDGES.length; i++) {
    if (seconds < HORIZON_EDGES[i]) return i
  }
  return HORIZON_EDGES.length
}

/** Human label for a bucket, for the analysis pages. */
export function horizonLabel(bucket: number): string {
  const lo = bucket === 0 ? 0 : HORIZON_EDGES[bucket - 1]
  const hi = bucket < HORIZON_EDGES.length ? HORIZON_EDGES[bucket] : null
  return hi === null ? `${lo}s+` : `${lo}-${hi}s`
}

/**
 * Three-hour periods, not half hours.
 *
 * `segment_profile` keys on half hours because congestion genuinely differs between 08:00
 * and 08:30. A producer's convergence behaviour does not — it is a property of the
 * prediction system, which changes across a morning peak and an evening lull but not
 * across thirty minutes. Coarser keying means roughly a tenth of the cells and evidence
 * accumulating ten times faster, which is why this converges in days rather than weeks.
 */
export const PERIODS_PER_DAY = 10

export function periodOf(serviceSeconds: number): number {
  return Math.min(PERIODS_PER_DAY - 1, Math.floor(bucketOf(serviceSeconds) / 6))
}

/** One measurement: at this horizon, this producer's estimate was this far from its last word. */
export interface DriftSample {
  agency: string
  routeId: string
  directionId: number
  horizon: number
  dayType: DayType
  period: number
  /**
   * Seconds. Positive means the agency's final answer was *later* than what it said at
   * this horizon — the countdown slipped as the vehicle approached.
   */
  drift: number
}

/**
 * A stop being tracked toward its arrival.
 *
 * One prediction retained per horizon bucket — the first seen in that bucket — rather than
 * the full history. Seven numbers per stop instead of hundreds, which is what keeps this
 * affordable across ~62,000 stop times a cycle.
 */
interface Tracked {
  agency: string
  routeId: string
  directionId: number
  /** bucket -> the predicted departure as it stood the first time we saw that bucket. */
  atHorizon: Map<number, number>
  /** The most recent prediction, and how far out it was when made. */
  last: number
  lastHorizon: number
  lastSeenCycle: number
}

/**
 * Only a stop we followed to within this many seconds of arrival has a trustworthy "final"
 * prediction.
 *
 * A stop that vanishes from the feed while still five minutes out was cancelled, rerouted,
 * or dropped by a flaky producer — its last prediction is not a converged answer, and
 * treating it as one would teach the model that this producer's estimates never move.
 * That error biases every bucket toward zero, which looks exactly like a well-behaved
 * agency.
 */
const FINAL_HORIZON_MAX = 60

/**
 * Predictions further out than this are not retained.
 *
 * Beyond twenty minutes a producer is mostly republishing the timetable, and the drift is
 * dominated by the schedule rather than by convergence.
 */
const MAX_TRACKED_HORIZON = 3600

/**
 * How far into the past a published prediction is still meaningful.
 *
 * Producers routinely publish a departure a few seconds behind the clock — "leaving now",
 * or a stop the vehicle has just cleared but the feed has not yet dropped. Those are the
 * closest thing to a measured passage the trip-update stream ever offers, so they are kept
 * and treated as horizon zero rather than discarded as nonsense.
 */
const PAST_GRACE = 60

/** Ceiling on tracked stops, so a feed anomaly cannot exhaust memory. */
const MAX_TRACKED = 250_000

export interface DriftStats {
  tracked: number
  emitted: number
  /** Dropped because the feed stopped mentioning the stop while it was still far out. */
  abandoned: number
  evicted: number
}

/**
 * Follows every stop in the feed until it arrives, then reports how the estimate moved.
 *
 * Pure in the sense that matters: state in, samples out, clock supplied by the caller.
 * Nothing here reads Redis, Postgres or the wall clock.
 */
export class DriftTracker {
  private readonly stops = new Map<string, Tracked>()
  private cycle = 0
  private stats: DriftStats = { tracked: 0, emitted: 0, abandoned: 0, evicted: 0 }

  /**
   * Folds one cycle of trip updates in and returns whatever finished.
   *
   * `now` is epoch seconds. `serviceDate` keys the day type and period; the caller owns
   * the calendar, exactly as `observe.ts` requires.
   */
  ingest(updates: TripUpdateRecord[], now: number, serviceDate: ServiceDate): DriftSample[] {
    this.cycle++
    const dayType = dayTypeOf(serviceDate)
    const period = periodOf(serviceSecondsOf(now, serviceDate))

    for (const update of updates) {
      // A cancelled trip's remaining stops never arrive, so its last prediction is not a
      // converged one. Letting these through would fill the short buckets with vehicles
      // that simply stopped being mentioned.
      if (update.relationship === 'CANCELED') continue

      const agency = agencyOf(update.tripId, update.routeId)
      if (!agency) continue

      for (const stop of update.stops) {
        if (stop.relationship === 'SKIPPED' || stop.relationship === 'NO_DATA') continue

        // Departure preferred over arrival, matching how the rest of this service treats a
        // stop time — and never mixed, since the two differ by the dwell.
        const predicted = stop.departure ?? stop.arrival
        if (!predicted) continue

        // A prediction slightly in the past is normal and is the most useful observation
        // there is: it is the producer saying the vehicle is leaving now or has just left.
        // Discarding it would throw away the converged answer every other bucket is
        // measured against, and the stop would then be abandoned for never having been
        // followed close enough to arrival.
        const horizon = predicted - now
        if (horizon < -PAST_GRACE || horizon > MAX_TRACKED_HORIZON) continue

        const key = `${update.tripId}\x1f${stop.stopId}`
        let state = this.stops.get(key)
        if (!state) {
          if (this.stops.size >= MAX_TRACKED) {
            this.stats.evicted++
            continue
          }
          state = {
            agency,
            routeId: update.routeId,
            directionId: update.directionId ?? 0,
            atHorizon: new Map(),
            last: predicted,
            lastHorizon: horizon,
            lastSeenCycle: this.cycle,
          }
          this.stops.set(key, state)
        }

        const bucket = horizonBucket(Math.max(0, horizon))
        // First sighting in a bucket only. A stop sits in the 300-600s bucket for five
        // minutes and would otherwise contribute twenty near-identical samples, which
        // inflates the evidence count without adding evidence.
        if (!state.atHorizon.has(bucket)) state.atHorizon.set(bucket, predicted)

        state.last = predicted
        state.lastHorizon = Math.max(0, horizon)
        state.lastSeenCycle = this.cycle
      }
    }

    return this.harvest(dayType, period)
  }

  /** Emits samples for every stop the feed stopped mentioning this cycle. */
  private harvest(dayType: DayType, period: number): DriftSample[] {
    const samples: DriftSample[] = []

    for (const [key, state] of this.stops) {
      if (state.lastSeenCycle === this.cycle) continue

      this.stops.delete(key)

      // Gone while still far out: no converged answer to measure against.
      if (state.lastHorizon > FINAL_HORIZON_MAX) {
        this.stats.abandoned++
        continue
      }

      for (const [bucket, predicted] of state.atHorizon) {
        samples.push({
          agency: state.agency,
          routeId: state.routeId,
          directionId: state.directionId,
          horizon: bucket,
          dayType,
          period,
          drift: state.last - predicted,
        })
      }
      this.stats.emitted++
    }

    this.stats.tracked = this.stops.size
    return samples
  }

  status(): DriftStats {
    return { ...this.stats, tracked: this.stops.size }
  }
}

/**
 * Agency prefix from a trip or route id.
 *
 * Duplicated from `gtfsrt.ts` rather than imported: nothing in the learning path may
 * import from the serving path, and one four-line function is a smaller price than a hole
 * in the firewall.
 */
function agencyOf(tripId: string, routeId: string): string | null {
  for (const id of [tripId, routeId]) {
    const colon = id.indexOf(':')
    if (colon > 0) return id.slice(0, colon)
  }
  return null
}
