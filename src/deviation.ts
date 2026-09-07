import { Tier, type StopEvent, type PredictionSample } from './observe.js'
import {
  ScheduleIndex,
  holdsAt,
  segmentKey,
  type Segment,
  type TripSchedule,
} from './schedule.js'
import { epochSecondsFor, bucketOf, dayTypeOf, DayType } from './servicedate.js'

/**
 * From "the bus was here at 08:31:47" to "this segment gave back forty seconds".
 *
 * The quantity everything downstream is built on is the **increment**: not how late a
 * vehicle is, but how much later or earlier it got on one segment. Absolute lateness is
 * mostly inherited — a jam at stop 4 is still visible at stop 34 — so a model of absolute
 * lateness relearns the same jam thirty times and can never say where it happened. The
 * increment is local, it is additive along a trip, and it is literally the answer to
 * "where is delay made up".
 *
 * Two rules here are load-bearing and easy to break later:
 *
 * 1. **Everything is departure-to-departure.** Where a producer publishes only one time
 *    per stop, that time is treated as the departure. Mixing departure-to-departure
 *    increments with departure-to-arrival ones into the same cell biases it by exactly the
 *    mean dwell — ten to thirty seconds — and the mixture ratio changes silently the day
 *    an operator swaps feed vendors.
 * 2. **A timepoint hold is not recovery.** See `censoring` below.
 */

export interface Deviation {
  agency: string
  tripId: string
  routeId: string
  directionId: number
  patternId: string
  blockId: string
  vehicleId?: string
  serviceDate: string
  stopId: string
  seq: number

  /** Epoch seconds. */
  scheduledArrival: number
  scheduledDeparture: number
  actualArrival?: number
  actualDeparture?: number

  /** Seconds late. Negative is early. */
  devArrival?: number
  devDeparture: number

  /** Departure deviation at the previous stop — the predictor of the conditional model. */
  priorDev?: number
  /** `devDeparture − priorDev`: what this segment did. Absent at the first observed stop. */
  delta?: number
  /** Observed dwell, only where the tier can see both ends of it. */
  dwell?: number

  segment?: Segment
  segmentKey?: string
  scheduledRun: number
  bucket: number
  dayType: DayType
  timepoint: boolean
  /**
   * The vehicle arrived early at a timepoint and was held.
   *
   * Recorded rather than smoothed away: at a held stop the departure deviation is
   * censored at roughly zero however early the vehicle was, so its *departure* says
   * nothing about how fast the segment ran.
   */
  held: boolean

  tier: Tier
  sigma: number
  composite: boolean
  predictions: PredictionSample[]
}

/**
 * How long past its scheduled time a held vehicle actually leaves.
 *
 * Not zero. Drivers open the doors, wait out the clock, and pull away a few seconds after
 * the published minute; measured across operators this sits in the +5 to +25 second range.
 * Assuming exactly zero makes every timepoint look very slightly late.
 */
export const DEFAULT_HOLD_OFFSET = 12

/** Below this, a "hold" is just an ordinary on-time departure. */
const HOLD_EARLY_THRESHOLD = -45

/**
 * Turns observations into deviations, remembering enough of each trip to compute
 * increments across cycles.
 *
 * Stateful only in that it remembers the last deviation seen on each trip; everything else
 * is a function of its arguments. The state is small (one number per active trip) and is
 * rebuilt harmlessly after a restart — the first stop observed on each trip afterwards
 * simply has no increment.
 */
export class DeviationTracker {
  /** tripId -> the last observed departure deviation and the sequence it was at. */
  private readonly last = new Map<string, { seq: number; dev: number; at: number }>()

  readonly stats = {
    produced: 0,
    noSchedule: 0,
    noPriorStop: 0,
    held: 0,
    outOfOrder: 0,
  }

  /** Drops trips nobody has reported on for a while, so this cannot grow all day. */
  prune(now: number, maxAgeSeconds = 7200): void {
    for (const [tripId, entry] of this.last) {
      if (now - entry.at > maxAgeSeconds) this.last.delete(tripId)
    }
  }

  get tracked(): number {
    return this.last.size
  }

  from(event: StopEvent, schedule: ScheduleIndex, holdOffset = DEFAULT_HOLD_OFFSET): Deviation | null {
    const trip = schedule.trip(event.tripId)
    if (!trip) {
      // No schedule means no baseline, so there is no deviation to compute. The event is
      // still worth writing down — `match: none` is how a service-change desync becomes
      // visible instead of just becoming a quiet hole in the data.
      this.stats.noSchedule++
      return null
    }

    const stop = trip.stops.find((s) => s.seq === event.seq)
    if (!stop) {
      this.stats.noSchedule++
      return null
    }

    const scheduledArrival = epochSecondsFor(event.serviceDate, stop.arrival)
    const scheduledDeparture = epochSecondsFor(event.serviceDate, stop.departure)

    // A composite observation is treated as a departure, per the rule at the top of this
    // file. Doing otherwise is how two incompatible populations end up in one cell.
    const actualDeparture = event.departure ?? event.arrival
    if (actualDeparture === undefined) return null
    const actualArrival = event.arrival

    const devDeparture = actualDeparture - scheduledDeparture
    const devArrival = actualArrival === undefined ? undefined : actualArrival - scheduledArrival

    const prior = this.last.get(event.tripId)
    let priorDev: number | undefined
    let delta: number | undefined

    if (prior && prior.seq < event.seq) {
      priorDev = prior.dev
      delta = devDeparture - prior.dev
    } else if (prior && prior.seq >= event.seq) {
      // Sequences must increase along a trip. Going backwards means a mismatched trip, a
      // reused vehicle id, or a producer replaying — none of which is a segment time.
      this.stats.outOfOrder++
    } else {
      this.stats.noPriorStop++
    }

    const segment = schedule.segments(event.tripId).find((s) => s.toSeq === event.seq)

    const modelsHold = holdsAt(trip, trip.stops.indexOf(stop))
    const held =
      modelsHold &&
      devArrival !== undefined &&
      devArrival < HOLD_EARLY_THRESHOLD &&
      devDeparture > devArrival + 30 &&
      Math.abs(devDeparture - holdOffset) < 90

    if (held) this.stats.held++

    this.last.set(event.tripId, { seq: event.seq, dev: devDeparture, at: actualDeparture })
    this.stats.produced++

    return {
      agency: event.agency,
      tripId: event.tripId,
      routeId: trip.routeId,
      directionId: trip.directionId,
      patternId: trip.patternId,
      blockId: trip.blockId,
      vehicleId: event.vehicleId,
      serviceDate: event.serviceDate,
      stopId: event.stopId,
      seq: event.seq,
      scheduledArrival,
      scheduledDeparture,
      actualArrival,
      actualDeparture,
      devArrival,
      devDeparture,
      priorDev,
      delta,
      dwell:
        actualArrival !== undefined && !event.composite
          ? Math.max(0, actualDeparture - actualArrival)
          : undefined,
      segment,
      segmentKey: segment ? segmentKey(segment) : undefined,
      scheduledRun: segment?.scheduledRun ?? 0,
      bucket: bucketOf(stop.departure),
      dayType: dayTypeOf(event.serviceDate),
      timepoint: modelsHold,
      held,
      tier: event.tier,
      sigma: event.sigma,
      composite: event.composite,
      predictions: event.predictions,
    }
  }
}

// ---------------------------------------------------------------------------
// Censoring
// ---------------------------------------------------------------------------

/**
 * What a held departure is actually evidence of.
 *
 * Muni, SamTrans and Golden Gate hold early vehicles at timepoints: the bus arrives four
 * minutes early, waits, and leaves on the minute. The departure deviation is therefore
 * censored — it is `max(arrival deviation + dwell, hold)` — and a model that averages
 * departures learns "this segment reliably absorbs four minutes of earliness". It does
 * not. It has a clock.
 *
 * The consequence downstream is worse than a wrong average: the model predicts recovery at
 * a stop where none happens, and a rider is told the bus is at the platform when it left
 * four minutes ago.
 *
 * So a held stop contributes its *arrival* deviation to the running-time model, and its
 * departure trains the holding model instead. Where only one time is published, the
 * observation is marked and excluded from the running-time model altogether rather than
 * guessed at.
 */
export interface CensoringDecision {
  /** The value the running-time model should learn from, if any. */
  trainRunning: number | null
  /** The value the holding model should learn from, if any. */
  trainHold: number | null
  reason: 'ordinary' | 'held-with-arrival' | 'held-composite' | 'timepoint-not-held'
}

export function censoring(d: Deviation): CensoringDecision {
  if (!d.timepoint) {
    return { trainRunning: d.devDeparture, trainHold: null, reason: 'ordinary' }
  }
  if (!d.held) {
    // A timepoint the vehicle was not early for behaves like any other stop.
    return { trainRunning: d.devDeparture, trainHold: null, reason: 'timepoint-not-held' }
  }
  if (d.devArrival !== undefined) {
    return {
      trainRunning: d.devArrival,
      trainHold: d.devDeparture,
      reason: 'held-with-arrival',
    }
  }
  // Held, and we cannot see how early it actually was. Nothing honest to learn about
  // running time from this one.
  return { trainRunning: null, trainHold: d.devDeparture, reason: 'held-composite' }
}

/**
 * Applies a hold when predicting forward.
 *
 * The mirror image of the above, and the reason the censoring has to be modelled rather
 * than merely excluded: an early vehicle approaching a timepoint will be held, so its
 * predicted departure is not its predicted arrival.
 */
export function applyHold(
  predictedDeparture: number,
  scheduledDeparture: number,
  isTimepoint: boolean,
  holdOffset = DEFAULT_HOLD_OFFSET,
): number {
  if (!isTimepoint) return predictedDeparture
  return Math.max(predictedDeparture, scheduledDeparture + holdOffset)
}

// ---------------------------------------------------------------------------
// Trip starts
// ---------------------------------------------------------------------------

/**
 * How late a trip left its origin.
 *
 * Worth its own profile: pull-out lateness is a garage property, not a traffic one, and
 * it is the entire prediction for a trip that has not started yet. Without it, a trip
 * outside the realtime horizon is predicted at its scheduled time — which for an operator
 * that habitually leaves four minutes late is wrong before the bus has moved.
 */
export function startDeviation(d: Deviation, trip: TripSchedule): number | null {
  return d.seq === trip.stops[0]?.seq ? d.devDeparture : null
}
