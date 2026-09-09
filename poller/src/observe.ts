import type { ScheduleIndex } from './schedule.js'

/**
 * Turning a stream of predictions into a record of what actually happened.
 *
 * This is the hardest and least obvious part of the system, because **GTFS-Realtime never
 * says when a bus left.** It says when a bus *will* leave, over and over, and then stops
 * mentioning the stop. Everything downstream — every profile, every correction, every
 * claim about where delay is made up — rests on how well this file infers an event that
 * was never published.
 *
 * So the inference is tiered and every observation carries the tier it came from and the
 * uncertainty that tier deserves. Nothing here averages across tiers silently.
 *
 * Pure by construction: in goes the previous state and this cycle's decoded feed, out come
 * events and the next state. No Redis, no clock but the one passed in. That is what makes
 * a state machine with this many corner cases testable at all.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type TripRelationship = 'SCHEDULED' | 'ADDED' | 'UNSCHEDULED' | 'CANCELED' | 'DUPLICATED'
export type StopRelationship = 'SCHEDULED' | 'SKIPPED' | 'NO_DATA'

export interface StopTimeRecord {
  stopId: string
  /** GTFS `stop_sequence`. Absent on some producers, which costs a tier. */
  seq?: number
  /** Epoch seconds. */
  arrival?: number
  departure?: number
  relationship?: StopRelationship
}

export interface TripUpdateRecord {
  tripId: string
  routeId: string
  directionId?: number
  /** `YYYYMMDD` from the trip descriptor, when the producer sets it. */
  startDate?: string
  /** `HH:MM:SS` from the trip descriptor. */
  startTime?: string
  relationship?: TripRelationship
  vehicleId?: string
  /** Epoch seconds the producer stamped on this trip's update. */
  timestamp?: number
  stops: StopTimeRecord[]
}

export interface VehicleRecord {
  vehicleId: string
  tripId?: string
  routeId?: string
  /**
   * Present only when the producer actually set the field.
   *
   * This matters more than it looks. `VehicleStopStatus` defaults to `IN_TRANSIT_TO`, so a
   * producer that never populates it decodes as "always in transit, never stopped" —
   * indistinguishable from a real vehicle that is genuinely always moving. Reading it as
   * present would mint an entire agency's worth of tier-A observations out of a field
   * nobody wrote. The decoder must check for the property, not for the value.
   */
  currentStatus?: 'INCOMING_AT' | 'STOPPED_AT' | 'IN_TRANSIT_TO'
  currentStopSequence?: number
  stopId?: string
  /** Epoch seconds the *vehicle* reported, not when we fetched. */
  timestamp?: number
}

export interface FeedCycle {
  /** Epoch seconds this cycle was fetched. */
  at: number
  updates: TripUpdateRecord[]
  vehicles: VehicleRecord[]
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * How an observation was arrived at, best first.
 *
 * The gap between A and C is not cosmetic. A tier-A observation is a vehicle saying where
 * it is; a tier-C observation is the last thing a *predictor* said before it went quiet.
 * Using tier C to grade a predictor measures how fast it converges on itself, not whether
 * it was right — see `calibrate.ts`.
 */
export enum Tier {
  /** Vehicle reported `STOPPED_AT` this stop, then moved on. Arrival and departure both bracketed. */
  A1 = 0,
  /** Sequence advanced past this stop but it was never seen `STOPPED_AT`. Composite, no dwell. */
  A2 = 1,
  /** Sequence skipped over this stop; crossing time interpolated from the schedule. */
  B = 2,
  /** Last prediction before the stop left the feed, corrected by a measured calibration. */
  C = 3,
  /** The same, with no calibration available for this agency. */
  Cu = 4,
  /** Closed out from stale state. Recorded for forensics, never used for training. */
  D = 5,
}

export const TIER_NAMES = ['A1', 'A2', 'B', 'C', 'Cu', 'D'] as const

/**
 * Standard error of each tier, in seconds.
 *
 * These are starting values, not measurements, and `docs/03-observation.md` says so. The
 * A tiers should be re-derived per agency from the *vehicle's own* reporting cadence
 * rather than from our poll interval: we sweep every 15 s, but a vehicle that reports
 * every 45 s is not observed to 15 s no matter how often we ask.
 */
export const TIER_SIGMA: Record<Tier, number> = {
  [Tier.A1]: 12,
  [Tier.A2]: 15,
  [Tier.B]: 35,
  [Tier.C]: 45,
  [Tier.Cu]: 90,
  [Tier.D]: 300,
}

/** Inverse-variance weight, normalised so a perfect observation is 1. */
export function tierWeight(tier: Tier, sigma?: number): number {
  const s = sigma ?? TIER_SIGMA[tier]
  const best = TIER_SIGMA[Tier.A1]
  return (best * best) / (s * s)
}

/** One prediction the feed made, kept so the predictor can be graded later. */
export interface PredictionSample {
  /** Seconds before the predicted event that this prediction was observed. */
  horizon: number
  /** What the feed said the time would be, epoch seconds. */
  predicted: number
}

export interface StopEvent {
  agency: string
  tripId: string
  routeId: string
  serviceDate: string
  stopId: string
  seq: number
  /** Epoch seconds. Present only when the tier can actually distinguish the two. */
  arrival?: number
  departure?: number
  tier: Tier
  sigma: number
  vehicleId?: string
  /** True when arrival and departure are the same observation, so dwell is unknowable. */
  composite: boolean
  /** The predictions the feed made about this event, coarsest horizon first. */
  predictions: PredictionSample[]
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Horizons, in seconds, at which the feed's prediction is sampled. */
export const HORIZONS = [1800, 1200, 900, 600, 300, 180, 120, 60] as const

/**
 * The tightest horizon bucket a prediction currently falls in, or null if it is further
 * out than we bother sampling.
 *
 * "Tightest" is what keeps the sampling honest: a prediction seen 100 seconds before the
 * event belongs in the 120-second bucket and nowhere else. Filing it under 1800 as well
 * would later be read as "the agency predicted this correctly half an hour out".
 */
export function horizonBucket(horizon: number): number | null {
  let best: number | null = null
  for (const h of HORIZONS) if (horizon <= h) best = h
  return best
}

interface StopState {
  stopId: string
  seq: number
  /** Latest predicted arrival/departure, epoch seconds. */
  arrival?: number
  departure?: number
  /** When we last saw this stop listed. */
  seenAt: number
  skipped: boolean
  samples: PredictionSample[]
  /** Horizons already sampled, so each is taken once. */
  taken: number[]
}

interface VehicleState {
  /** The last sequence the vehicle reported, and how. */
  seq: number
  status: 'INCOMING_AT' | 'STOPPED_AT' | 'IN_TRANSIT_TO'
  at: number
  /** First and last time we saw `STOPPED_AT` at `seq`. */
  stoppedFrom?: number
  stoppedTo?: number
}

export interface TripState {
  agency: string
  routeId: string
  serviceDate: string
  vehicleId?: string
  /** Stop id + sequence, because a looping route visits a stop id twice. */
  stops: Map<string, StopState>
  vehicle?: VehicleState
  /** Sequences already emitted, so a stop is never observed twice. */
  emitted: Set<number>
  lastSeen: number
  /** Fingerprint of last cycle's predictions, for the frozen-producer guard. */
  fingerprint: string
}

export interface TrackerOptions {
  /** Which agencies produce observations at all. */
  profiled: Set<string>
  /** Calibrated agencies get tier C; the rest get Cu. */
  calibrated?: Set<string>
  /** A vehicle position older than this is not evidence of anything. */
  staleVehicleSeconds?: number
  /** Sequence gaps wider than this are not interpolated. */
  maxGap?: number
  /** A trip unseen for this long is closed out. */
  tripTimeoutSeconds?: number
  /** Below this many trips, an unchanged feed is not evidence of a frozen producer. */
  frozenMinTrips?: number
}

function stopKey(stopId: string, seq: number): string {
  return `${seq}${stopId}`
}

function agencyOf(id: string): string {
  const i = id.indexOf(':')
  return i > 0 ? id.slice(0, i) : ''
}

// ---------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------

export class TripTracker {
  private readonly trips = new Map<string, TripState>()
  private readonly opts: Required<TrackerOptions>

  /** Counters for `/health`; every one of these is a thing that can silently go wrong. */
  readonly stats = {
    cycles: 0,
    events: 0,
    byTier: [0, 0, 0, 0, 0, 0],
    frozenAgencies: 0,
    staleVehicles: 0,
    skippedStops: 0,
    unmatchedTrips: 0,
    duplicateEntities: 0,
    gapsTooWide: 0,
  }

  /** Fingerprint of each agency's last cycle, for the frozen-producer guard. */
  private readonly agencyFingerprints = new Map<string, string>()

  constructor(options: TrackerOptions) {
    this.opts = {
      calibrated: new Set(),
      staleVehicleSeconds: 120,
      maxGap: 3,
      tripTimeoutSeconds: 600,
      frozenMinTrips: 5,
      ...options,
    }
  }

  get activeTrips(): number {
    return this.trips.size
  }

  /**
   * One cycle: diff the feed against what we remember and emit what has happened since.
   *
   * `resolveServiceDate` is injected rather than imported so the caller owns the calendar
   * — the tracker has no business knowing which service ids run today.
   */
  ingest(
    cycle: FeedCycle,
    schedule: ScheduleIndex,
    resolveServiceDate: (u: TripUpdateRecord, at: number) => string | null,
  ): StopEvent[] {
    this.stats.cycles++
    const events: StopEvent[] = []

    const vehicleByTrip = this.indexVehicles(cycle)
    const seenTrips = new Set<string>()
    const byAgency = new Map<string, TripUpdateRecord[]>()

    for (const update of cycle.updates) {
      const agency = agencyOf(update.tripId) || agencyOf(update.routeId)
      if (!agency || !this.opts.profiled.has(agency)) continue
      const list = byAgency.get(agency)
      if (list) list.push(update)
      else byAgency.set(agency, [update])
    }

    for (const [agency, updates] of byAgency) {
      // A producer can freeze while the regional feed's own header keeps advancing,
      // because that header belongs to 511, not to the operator. A frozen producer's
      // stops never leave the list and its predictions never move — which reads exactly
      // like a fleet that has stopped moving, and would mint a cycle's worth of fictional
      // "the prediction converged" observations.
      //
      // Only above a handful of trips, though. At 3 a.m. an operator can legitimately have
      // two trips out whose predictions genuinely did not move in fifteen seconds, and
      // suppressing those would blind us to exactly the overnight hours that are hardest
      // to collect. "Nothing changed" is evidence of a frozen producer only when there was
      // enough going on for something to have changed.
      const fingerprint = fingerprintOf(updates)
      if (updates.length >= this.opts.frozenMinTrips && this.agencyFingerprints.get(agency) === fingerprint) {
        this.stats.frozenAgencies++
        for (const u of updates) seenTrips.add(u.tripId)
        continue
      }
      this.agencyFingerprints.set(agency, fingerprint)

      for (const update of updates) {
        if (seenTrips.has(update.tripId)) {
          // The regional feed occasionally carries two entities for one trip. Taking the
          // last silently halves that trip's observations for the day.
          this.stats.duplicateEntities++
          continue
        }
        seenTrips.add(update.tripId)

        if (update.relationship === 'CANCELED') {
          this.trips.delete(update.tripId)
          continue
        }

        const serviceDate = resolveServiceDate(update, cycle.at)
        if (!serviceDate) {
          this.stats.unmatchedTrips++
          continue
        }

        events.push(
          ...this.ingestTrip(update, cycle.at, agency, serviceDate, schedule, vehicleByTrip),
        )
      }
    }

    // A trip that has fallen out of the feed entirely. Its remaining stops are closed out
    // at tier D purely so the gap is visible in the record; nothing trains on them.
    for (const [tripId, state] of this.trips) {
      if (seenTrips.has(tripId)) continue
      if (cycle.at - state.lastSeen < this.opts.tripTimeoutSeconds) continue
      this.trips.delete(tripId)
    }

    for (const e of events) {
      this.stats.events++
      this.stats.byTier[e.tier]++
    }
    return events
  }

  private indexVehicles(cycle: FeedCycle): Map<string, VehicleRecord> {
    const out = new Map<string, VehicleRecord>()
    for (const v of cycle.vehicles) {
      if (!v.tripId) continue
      if (v.timestamp && cycle.at - v.timestamp > this.opts.staleVehicleSeconds) {
        // A position ten minutes old says where a bus *was*. Treating it as current
        // manufactures a transition at the moment the stale record happens to arrive.
        this.stats.staleVehicles++
        continue
      }
      out.set(v.tripId, v)
    }
    return out
  }

  private ingestTrip(
    update: TripUpdateRecord,
    at: number,
    agency: string,
    serviceDate: string,
    schedule: ScheduleIndex,
    vehicles: Map<string, VehicleRecord>,
  ): StopEvent[] {
    let state = this.trips.get(update.tripId)
    if (!state) {
      state = {
        agency,
        routeId: update.routeId,
        serviceDate,
        stops: new Map(),
        emitted: new Set(),
        lastSeen: at,
        fingerprint: '',
      }
      this.trips.set(update.tripId, state)
    }
    state.vehicleId = update.vehicleId ?? vehicles.get(update.tripId)?.vehicleId ?? state.vehicleId

    const events: StopEvent[] = []
    const present = new Set<string>()

    // --- 1. absorb this cycle's predictions ---------------------------------
    for (const stu of update.stops) {
      const seq = stu.seq ?? schedule.seqOf(update.tripId, stu.stopId)
      if (seq < 0) continue
      const key = stopKey(stu.stopId, seq)
      present.add(key)

      const prior = state.stops.get(key)
      const next: StopState = prior ?? {
        stopId: stu.stopId,
        seq,
        seenAt: at,
        skipped: false,
        samples: [],
        taken: [],
      }
      next.seenAt = at
      if (stu.relationship === 'SKIPPED') next.skipped = true
      if (stu.arrival !== undefined) next.arrival = stu.arrival
      if (stu.departure !== undefined) next.departure = stu.departure

      // Sample the prediction as it crosses each horizon, once each. This is the raw
      // material for grading the agency's predictor, and it has to be captured live —
      // by the time the event happens, the prediction that mattered is gone.
      //
      // At most one bucket per cycle, and only the one the horizon is actually in. The
      // obvious loop — fill every bucket this horizon is under — quietly claims we saw a
      // half-hour-out prediction for a trip we first noticed ninety seconds before it
      // left, which is the agency's predictor being credited for work we never watched it
      // do. A bucket nobody observed stays empty, and `score.ts` reports it as absent
      // rather than as accurate.
      const target = next.departure ?? next.arrival
      if (target !== undefined && stu.relationship !== 'SKIPPED') {
        const bucket = horizonBucket(target - at)
        if (bucket !== null && !next.taken.includes(bucket)) {
          next.taken.push(bucket)
          next.samples.push({ horizon: bucket, predicted: target })
        }
      }

      state.stops.set(key, next)
    }

    // --- 2. position-derived events (tiers A and B) --------------------------
    const vehicle = vehicles.get(update.tripId)
    if (vehicle?.currentStatus !== undefined && vehicle.currentStopSequence !== undefined) {
      events.push(...this.fromPosition(update.tripId, state, vehicle, at, schedule))
    }

    // --- 3. disappearance events (tier C) -----------------------------------
    for (const [key, stop] of state.stops) {
      if (present.has(key)) continue
      state.stops.delete(key)
      if (state.emitted.has(stop.seq)) continue

      if (stop.skipped) {
        // The stop left the list because it was skipped, not because it was served.
        this.stats.skippedStops++
        continue
      }

      // A stop can also vanish because the producer truncated the trip. Only treat the
      // disappearance as a passage if the *next* stop is still being predicted — that is
      // what distinguishes "the bus went past" from "the feed lost the trip".
      const nextStillPresent = [...present].some((k) => {
        const s = state!.stops.get(k)
        return s !== undefined && s.seq > stop.seq
      })
      if (!nextStillPresent) continue

      const time = stop.departure ?? stop.arrival
      if (time === undefined) continue

      const tier = this.opts.calibrated.has(agency) ? Tier.C : Tier.Cu
      state.emitted.add(stop.seq)
      events.push({
        agency,
        tripId: update.tripId,
        routeId: update.routeId,
        serviceDate,
        stopId: key.slice(key.indexOf('') + 1),
        seq: stop.seq,
        departure: time,
        tier,
        sigma: TIER_SIGMA[tier],
        vehicleId: state.vehicleId,
        composite: true,
        predictions: stop.samples,
      })
    }

    state.lastSeen = at
    return events
  }

  /**
   * Events derived from where the vehicle says it is.
   *
   * Three transitions matter, and the difference between them is the difference between
   * knowing a dwell and guessing one:
   *
   * - `STOPPED_AT n` seen, then anything beyond n  -> we bracketed both the arrival and
   *   the departure. Tier A1, and the only tier that can measure dwell.
   * - sequence advances n -> n+1 with no `STOPPED_AT` in between -> we know it went past,
   *   to within the reporting gap, but not how long it sat. Tier A2, composite.
   * - sequence jumps n -> n+k -> the stops in between were passed somewhere in that
   *   window; split it by scheduled running time. Tier B, and the uncertainty grows with
   *   k until it is not worth having.
   */
  private fromPosition(
    tripId: string,
    state: TripState,
    vehicle: VehicleRecord,
    at: number,
    schedule: ScheduleIndex,
  ): StopEvent[] {
    const seq = vehicle.currentStopSequence!
    const status = vehicle.currentStatus!
    const reportedAt = vehicle.timestamp ?? at
    const prior = state.vehicle

    const events: StopEvent[] = []

    if (prior && seq > prior.seq) {
      const gap = seq - prior.seq
      if (gap > this.opts.maxGap) {
        this.stats.gapsTooWide++
      } else {
        events.push(
          ...this.closeOut(tripId, state, prior, seq, reportedAt, schedule, gap),
        )
      }
    }

    // Track the dwell bracket at the current stop.
    const next: VehicleState = { seq, status, at: reportedAt }
    if (status === 'STOPPED_AT') {
      next.stoppedFrom = prior?.seq === seq ? (prior.stoppedFrom ?? reportedAt) : reportedAt
      next.stoppedTo = reportedAt
    } else if (prior?.seq === seq) {
      next.stoppedFrom = prior.stoppedFrom
      next.stoppedTo = prior.stoppedTo
    }
    state.vehicle = next

    return events
  }

  private closeOut(
    tripId: string,
    state: TripState,
    prior: VehicleState,
    newSeq: number,
    at: number,
    schedule: ScheduleIndex,
    gap: number,
  ): StopEvent[] {
    const trip = schedule.trip(tripId)
    const events: StopEvent[] = []

    // The stop the vehicle has just left.
    if (!state.emitted.has(prior.seq)) {
      const stop = trip?.stops.find((s) => s.seq === prior.seq)
      const stopId = stop?.stopId ?? this.stopIdFor(state, prior.seq)
      if (stopId) {
        state.emitted.add(prior.seq)
        if (prior.stoppedFrom !== undefined && prior.stoppedTo !== undefined) {
          // Both ends bracketed: arrival is somewhere in the report before the first
          // STOPPED_AT, departure somewhere between the last one and now.
          events.push({
            agency: state.agency,
            tripId,
            routeId: state.routeId,
            serviceDate: state.serviceDate,
            stopId,
            seq: prior.seq,
            arrival: prior.stoppedFrom,
            departure: Math.round((prior.stoppedTo + at) / 2),
            tier: Tier.A1,
            sigma: TIER_SIGMA[Tier.A1],
            vehicleId: state.vehicleId,
            composite: false,
            predictions: this.samplesFor(state, prior.seq),
          })
        } else {
          events.push({
            agency: state.agency,
            tripId,
            routeId: state.routeId,
            serviceDate: state.serviceDate,
            stopId,
            seq: prior.seq,
            departure: Math.round((prior.at + at) / 2),
            tier: Tier.A2,
            sigma: TIER_SIGMA[Tier.A2] + Math.round((at - prior.at) / 4),
            vehicleId: state.vehicleId,
            composite: true,
            predictions: this.samplesFor(state, prior.seq),
          })
        }
      }
    }

    // Anything jumped over, placed by scheduled running time rather than evenly: a
    // 90-second hop and a 4-minute one inside the same window did not each take half.
    if (gap > 1 && trip) {
      const skipped = trip.stops.filter((s) => s.seq > prior.seq && s.seq < newSeq)
      const window = at - prior.at
      const spanStart = trip.stops.find((s) => s.seq === prior.seq)?.departure
      const spanEnd = trip.stops.find((s) => s.seq === newSeq)?.arrival
      const span = spanStart !== undefined && spanEnd !== undefined ? spanEnd - spanStart : 0

      for (const s of skipped) {
        if (state.emitted.has(s.seq)) continue
        const fraction = span > 0 && spanStart !== undefined ? (s.arrival - spanStart) / span : 0.5
        state.emitted.add(s.seq)
        events.push({
          agency: state.agency,
          tripId,
          routeId: state.routeId,
          serviceDate: state.serviceDate,
          stopId: s.stopId,
          seq: s.seq,
          departure: Math.round(prior.at + window * Math.min(1, Math.max(0, fraction))),
          tier: Tier.B,
          sigma: TIER_SIGMA[Tier.B] + 20 * (gap - 1),
          vehicleId: state.vehicleId,
          composite: true,
          predictions: this.samplesFor(state, s.seq),
        })
      }
    }

    return events
  }

  private stopIdFor(state: TripState, seq: number): string | null {
    for (const [key, stop] of state.stops) {
      if (stop.seq === seq) return key.slice(key.indexOf('') + 1)
    }
    return null
  }

  private samplesFor(state: TripState, seq: number): PredictionSample[] {
    for (const stop of state.stops.values()) {
      if (stop.seq === seq) return stop.samples
    }
    return []
  }
}

/**
 * A cheap summary of what a producer said this cycle.
 *
 * Deliberately includes the predicted times, not just the trip ids: an operator whose
 * feed has frozen still lists the same trips, and the tell is that none of the numbers
 * have moved.
 */
export function fingerprintOf(updates: TripUpdateRecord[]): string {
  let h = 0
  for (const u of updates) {
    h = (h * 31 + hashString(u.tripId)) | 0
    for (const s of u.stops) {
      h = (h * 31 + (s.departure ?? s.arrival ?? 0)) | 0
    }
  }
  return `${updates.length}:${h}`
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}
