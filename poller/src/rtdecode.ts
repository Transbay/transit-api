import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import type {
  TripUpdateRecord,
  VehicleRecord,
  StopRelationship,
  TripRelationship,
} from './observe.js'

const { transit_realtime: rt } = GtfsRealtimeBindings

/**
 * The raw feed, decoded for the learner.
 *
 * Deliberately a separate module from `gtfsrt.ts`, which translates the same bytes into
 * the SIRI envelope the app reads. That separation is the **learning firewall**: the model
 * trains on what the agency published, never on anything this service has shaped, filtered
 * or corrected. If the learner ever consumed the serving path's output it would drift into
 * agreeing with itself, and the symptom — a model that scores beautifully and predicts
 * badly — is one of the hardest kinds of wrong to notice.
 *
 * Keep it that way. Nothing in this file may import from `gtfsrt.ts`, `snapshot.ts` or
 * `serve*.ts`, and nothing there may import from here.
 */

/**
 * Whether a protobuf field was actually on the wire.
 *
 * The single most dangerous thing in this file. GTFS-RT is proto2 and
 * `VehiclePosition.current_status` is declared `[default = IN_TRANSIT_TO]`, so protobufjs
 * hands back `IN_TRANSIT_TO` for a producer that never wrote the field at all. Read
 * naively, an agency that publishes no status becomes an agency whose vehicles are
 * permanently in transit and never stopped — which is indistinguishable from a real fleet,
 * and would manufacture an entire operator's worth of high-confidence observations out of
 * a field nobody set.
 *
 * Decoded messages carry own properties only for fields that were present, so presence is
 * a `hasOwnProperty` check and never a comparison against the default value.
 */
function present(msg: object | null | undefined, field: string): boolean {
  return msg != null && Object.prototype.hasOwnProperty.call(msg, field)
}

const STOP_RELATIONSHIP: Record<number, StopRelationship> = {
  0: 'SCHEDULED',
  1: 'SKIPPED',
  2: 'NO_DATA',
}

const TRIP_RELATIONSHIP: Record<number, TripRelationship> = {
  0: 'SCHEDULED',
  1: 'ADDED',
  2: 'UNSCHEDULED',
  3: 'CANCELED',
  4: 'DUPLICATED',
}

const VEHICLE_STATUS: Record<number, VehicleRecord['currentStatus']> = {
  0: 'INCOMING_AT',
  1: 'STOPPED_AT',
  2: 'IN_TRANSIT_TO',
}

export interface DecodedFeed {
  /** Feed generation time, epoch seconds. */
  timestamp: number
  updates: TripUpdateRecord[]
  vehicles: VehicleRecord[]
  /** What the feed contained, for the forensics report and for `/health`. */
  survey: FeedSurvey
}

/**
 * What this feed actually carries, per agency.
 *
 * Measured every cycle rather than assumed once, because the answers change: a producer
 * starts publishing `stop_sequence`, an operator's vendor changes, a field quietly
 * disappears. Every one of those silently changes which observation tier is available, and
 * a tier changing without anybody noticing is how a profile ends up trained on something
 * other than what its documentation claims.
 */
export interface AgencySurvey {
  trips: number
  vehicles: number
  withStartDate: number
  withStopSequence: number
  withCurrentStatus: number
  everStopped: number
  withArrivalAndDeparture: number
  skipped: number
  canceled: number
  added: number
  /** Trips whose every predicted time equals the schedule — a passthrough, not realtime. */
  schedulePassthrough: number
}

export type FeedSurvey = Map<string, AgencySurvey>

function blankSurvey(): AgencySurvey {
  return {
    trips: 0,
    vehicles: 0,
    withStartDate: 0,
    withStopSequence: 0,
    withCurrentStatus: 0,
    everStopped: 0,
    withArrivalAndDeparture: 0,
    skipped: 0,
    canceled: 0,
    added: 0,
    schedulePassthrough: 0,
  }
}

function surveyFor(survey: FeedSurvey, agency: string): AgencySurvey {
  let s = survey.get(agency)
  if (!s) survey.set(agency, (s = blankSurvey()))
  return s
}

/** Which agency an id belongs to. The regional feed prefixes everything. */
export function agencyOf(tripId: string, routeId: string): string | null {
  for (const id of [tripId, routeId]) {
    const colon = id.indexOf(':')
    if (colon > 0) return id.slice(0, colon)
  }
  return null
}

/** Decodes `tripupdates`, keeping the fields the SIRI translation has no use for. */
export function decodeTripUpdates(
  buffer: Uint8Array,
  agencies: Set<string> | null,
  survey: FeedSurvey = new Map(),
): { timestamp: number; updates: TripUpdateRecord[]; survey: FeedSurvey } {
  const feed = rt.FeedMessage.decode(buffer)
  const timestamp = Number(feed.header?.timestamp ?? 0) || Math.floor(Date.now() / 1000)
  const updates: TripUpdateRecord[] = []

  for (const entity of feed.entity) {
    const update = entity.tripUpdate
    if (!update?.trip) continue

    const tripId = update.trip.tripId ?? ''
    const routeId = update.trip.routeId ?? ''
    const agency = agencyOf(tripId, routeId)
    if (!agency) continue
    if (agencies && !agencies.has(agency)) continue

    const s = surveyFor(survey, agency)
    s.trips++
    if (present(update.trip, 'startDate')) s.withStartDate++

    const relationship = present(update.trip, 'scheduleRelationship')
      ? TRIP_RELATIONSHIP[update.trip.scheduleRelationship as number]
      : undefined
    if (relationship === 'CANCELED') s.canceled++
    if (relationship === 'ADDED') s.added++

    const stops: TripUpdateRecord['stops'] = []
    let both = 0
    for (const stu of update.stopTimeUpdate ?? []) {
      const stopId = stu.stopId
      if (!stopId) continue

      const arrival = Number(stu.arrival?.time ?? 0)
      const departure = Number(stu.departure?.time ?? 0)
      const stopRelationship = present(stu, 'scheduleRelationship')
        ? STOP_RELATIONSHIP[stu.scheduleRelationship as number]
        : undefined
      if (stopRelationship === 'SKIPPED') s.skipped++
      if (arrival > 0 && departure > 0) both++

      if (present(stu, 'stopSequence')) s.withStopSequence++

      stops.push({
        stopId,
        seq: present(stu, 'stopSequence') ? Number(stu.stopSequence) : undefined,
        arrival: arrival > 0 ? arrival : undefined,
        departure: departure > 0 ? departure : undefined,
        relationship: stopRelationship,
      })
    }
    if (stops.length > 0 && both === stops.length) s.withArrivalAndDeparture++

    updates.push({
      tripId,
      routeId,
      directionId: present(update.trip, 'directionId') ? Number(update.trip.directionId) : undefined,
      startDate: present(update.trip, 'startDate') ? String(update.trip.startDate) : undefined,
      startTime: present(update.trip, 'startTime') ? String(update.trip.startTime) : undefined,
      relationship,
      vehicleId: update.vehicle?.id || update.vehicle?.label || undefined,
      timestamp: present(update, 'timestamp') ? Number(update.timestamp) : undefined,
      stops,
    })
  }

  return { timestamp, updates, survey }
}

/** Decodes `vehiclepositions`, including the two fields that make tier A possible. */
export function decodeVehicles(
  buffer: Uint8Array,
  agencies: Set<string> | null,
  survey: FeedSurvey = new Map(),
): { vehicles: VehicleRecord[]; survey: FeedSurvey } {
  const feed = rt.FeedMessage.decode(buffer)
  const vehicles: VehicleRecord[] = []

  for (const entity of feed.entity) {
    const v = entity.vehicle
    if (!v) continue

    const tripId = v.trip?.tripId ?? ''
    const routeId = v.trip?.routeId ?? ''
    const agency = agencyOf(tripId, routeId)
    if (!agency) continue
    if (agencies && !agencies.has(agency)) continue

    const s = surveyFor(survey, agency)
    s.vehicles++

    const hasStatus = present(v, 'currentStatus')
    if (hasStatus) s.withCurrentStatus++
    if (hasStatus && Number(v.currentStatus) === 1) s.everStopped++

    vehicles.push({
      vehicleId: v.vehicle?.id || v.vehicle?.label || entity.id,
      tripId: tripId || undefined,
      routeId: routeId || undefined,
      currentStatus: hasStatus ? VEHICLE_STATUS[Number(v.currentStatus)] : undefined,
      currentStopSequence: present(v, 'currentStopSequence')
        ? Number(v.currentStopSequence)
        : undefined,
      stopId: v.stopId ?? undefined,
      timestamp: present(v, 'timestamp') ? Number(v.timestamp) : undefined,
    })
  }

  return { vehicles, survey }
}

/**
 * Counts trips whose predictions are simply the timetable read back.
 *
 * A producer with nothing live to say often republishes the schedule rather than staying
 * quiet, and the result is indistinguishable from a realtime prediction unless you look.
 * It matters twice over: those trips are not evidence about the agency's predictor, and a
 * departure board that presents them as live is telling a rider something it does not know.
 *
 * `scheduleAt` returns the scheduled epoch time for a stop, or null if we have no schedule
 * for it — a trip we cannot check is not counted either way.
 */
export function countSchedulePassthrough(
  updates: TripUpdateRecord[],
  scheduleAt: (tripId: string, stopId: string, seq?: number) => number | null,
  survey: FeedSurvey,
  toleranceSeconds = 5,
): void {
  for (const u of updates) {
    const agency = agencyOf(u.tripId, u.routeId)
    if (!agency) continue

    let checked = 0
    let identical = 0
    for (const stu of u.stops) {
      const predicted = stu.departure ?? stu.arrival
      if (predicted === undefined) continue
      const scheduled = scheduleAt(u.tripId, stu.stopId, stu.seq)
      if (scheduled === null) continue
      checked++
      if (Math.abs(predicted - scheduled) <= toleranceSeconds) identical++
    }

    if (checked >= 3 && identical === checked) surveyFor(survey, agency).schedulePassthrough++
  }
}

/** Merges one cycle's survey into a running total. */
export function mergeSurvey(into: FeedSurvey, from: FeedSurvey): FeedSurvey {
  for (const [agency, s] of from) {
    const target = surveyFor(into, agency)
    for (const key of Object.keys(s) as (keyof AgencySurvey)[]) target[key] += s[key]
  }
  return into
}

/** The survey as something a health endpoint or a report can print. */
export function surveyToJSON(survey: FeedSurvey): Record<string, AgencySurvey & { tierA: boolean }> {
  const out: Record<string, AgencySurvey & { tierA: boolean }> = {}
  for (const [agency, s] of survey) {
    out[agency] = {
      ...s,
      // The question that decides what this agency's history is worth: does anything ever
      // report itself as stopped? Without that, actual times are inferred from predictions
      // and the prediction-error model cannot be trained without circularity.
      tierA: s.everStopped > 0 && s.withCurrentStatus > 0,
    }
  }
  return out
}
