import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import type { TripInfo, StopInfo } from './gtfs.js'
import type { MonitoredStopVisit } from './siri.js'

const { transit_realtime: rt } = GtfsRealtimeBindings

// Translates the regional GTFS-Realtime feed back into the SIRI shape the app speaks,
// so no client change is needed. See README section 3.

/** ISO8601 the way 511's SIRI wrote it: whole seconds, `Z`, no fractional part. */
function isoSeconds(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Which agency a trip belongs to. */
function agencyOf(tripId: string, routeId: string): string | null {
  for (const id of [tripId, routeId]) {
    const colon = id.indexOf(':')
    if (colon > 0) return id.slice(0, colon)
  }
  return null
}

export interface GroupedRealtime {
  /** agency -> stop id -> the visits at that stop. */
  byAgency: Map<string, Map<string, MonitoredStopVisit[]>>
  /** Feed generation time, used as the snapshot's `ResponseTimestamp`. */
  responseTimestamp: string
  /** Trips in the live feed that the static table has never heard of. */
  unmatchedTrips: number
  totalVisits: number
}

/** Splits one regional `tripupdates` feed into per-agency, per-stop SIRI visits. */
export function groupTripUpdates(
  buffer: Uint8Array,
  trips: Map<string, TripInfo>,
  stops: Map<string, StopInfo>,
  agencies: Set<string>,
): GroupedRealtime {
  const feed = rt.FeedMessage.decode(buffer)

  const feedTime = Number(feed.header?.timestamp ?? 0)
  const responseTimestamp = isoSeconds(feedTime > 0 ? feedTime : Math.floor(Date.now() / 1000))

  const byAgency = new Map<string, Map<string, MonitoredStopVisit[]>>()
  let unmatchedTrips = 0
  let totalVisits = 0

  for (const entity of feed.entity) {
    const update = entity.tripUpdate
    if (!update?.trip) continue

    const tripId = update.trip.tripId ?? ''
    const routeId = update.trip.routeId ?? ''

    const agency = agencyOf(tripId, routeId)
    if (!agency || !agencies.has(agency)) continue

    /** A trip in the live feed that the static table has never heard of. */
    const info = trips.get(tripId)
    if (!info) unmatchedTrips++

    const lineRef = info?.lineRef ?? stripAgencyPrefix(routeId)
    const lineName = info?.lineName || lineRef
    const destination = info?.destination ?? ''
    const directionRef =
      info?.directionRef ?? (update.trip.directionId === 1 ? 'IB' : 'OB')

    // GTFS-RT names the vehicle; SIRI split that across two fields, and the client
    // reads both. `trip_short_name` is the train number riders use, so it goes where
    // the app already looks for it.
    const vehicleRef = update.vehicle?.label || update.vehicle?.id || ''
    const journeyRef = info?.shortName || stripAgencyPrefix(tripId)

    let stopMap = byAgency.get(agency)
    if (!stopMap) byAgency.set(agency, (stopMap = new Map()))

    for (const stu of update.stopTimeUpdate ?? []) {
      const stopId = stu.stopId
      if (!stopId) continue

      // Prefer departure over arrival: a rider at a stop cares when the bus leaves,
      // and at a terminal the arrival can be many minutes earlier. This mirrors the
      // Expected-before-Aimed ladder in `SIRIMapping.swift`.
      const departureTime = Number(stu.departure?.time ?? 0)
      const arrivalTime = Number(stu.arrival?.time ?? 0)
      if (departureTime <= 0 && arrivalTime <= 0) continue

      /**
       * Everything here is real-time, so it goes in the `Expected*` fields.
       *
       * `SIRIMapping.swift` sets `isRealtime` from the presence of an `Expected*`
       * value, and prefers all Expected values over any Aimed one. Writing these
       * times into `Aimed*` instead would make every departure in the app render as
       * a scheduled time — greyed out, no live indicator — despite being live data.
       */
      const call: Record<string, string> = {}
      const stopName = stops.get(stopId)?.name
      if (stopName) call.StopPointName = stopName
      if (arrivalTime > 0) call.ExpectedArrivalTime = isoSeconds(arrivalTime)
      if (departureTime > 0) call.ExpectedDepartureTime = isoSeconds(departureTime)

      const visit: MonitoredStopVisit = {
        MonitoringRef: stopId,
        MonitoredVehicleJourney: {
          LineRef: lineRef,
          DirectionRef: directionRef,
          PublishedLineName: lineName,
          DestinationName: destination,
          OperatorRef: agency,
          ...(vehicleRef ? { VehicleRef: vehicleRef } : {}),
          FramedVehicleJourneyRef: { DatedVehicleJourneyRef: journeyRef },
          MonitoredCall: call,
        },
      }

      const bucket = stopMap.get(stopId)
      if (bucket) bucket.push(visit)
      else stopMap.set(stopId, [visit])
      totalVisits++
    }
  }

  // The app renders whatever order it receives after its own sort, but sorting here
  // makes the stored snapshot readable when debugging, and costs nothing at this size.
  for (const stopMap of byAgency.values()) {
    for (const visits of stopMap.values()) {
      visits.sort((a, b) => callTime(a).localeCompare(callTime(b)))
    }
  }

  return { byAgency, responseTimestamp, unmatchedTrips, totalVisits }
}

function callTime(visit: MonitoredStopVisit): string {
  const call = (visit.MonitoredVehicleJourney as Record<string, unknown> | undefined)
    ?.MonitoredCall as Record<string, string> | undefined
  return call?.ExpectedDepartureTime ?? call?.ExpectedArrivalTime ?? ''
}

function stripAgencyPrefix(id: string): string {
  const colon = id.indexOf(':')
  return colon >= 0 ? id.slice(colon + 1) : id
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

/** One vehicle, as the app would want it on a map. */
export interface VehicleRecord {
  id: string
  agency: string
  lineRef: string
  lineName: string
  destination: string
  directionRef: string
  lat: number
  lon: number
  bearing?: number
  speed?: number
  /** Where it is heading next, named rather than as a bare id. */
  nextStop?: string
  nextStopId?: string
  occupancy?: string
  /** When the vehicle reported this position. */
  at: string
  /**
   * How this position was arrived at.
   *
   * `gtfsrt` was reported by the vehicle. `synthesized` was inferred from arrival
   * predictions and track geometry, because BART publishes no positions at all. A
   * consumer must be able to tell them apart: an inferred dot drawn identically to a
   * measured one is a confident lie.
   */
  source?: 'gtfsrt' | 'synthesized'
  /** `low` means a straight-line fallback or missing geometry. */
  confidence?: 'high' | 'low'
}

/** GTFS-RT's occupancy enum, as something readable. */
const OCCUPANCY: Record<number, string> = {
  0: 'empty',
  1: 'many seats',
  2: 'few seats',
  3: 'standing room',
  4: 'crushed',
  5: 'full',
  6: 'not accepting',
}

/**
 * Decodes the regional `vehiclepositions` feed.
 *
 * Same join as departures — ids from the live feed, names from this morning's static
 * tables — and the same agency filter, for the same reason.
 */
export function decodeVehiclePositions(
  buffer: Uint8Array,
  trips: Map<string, TripInfo>,
  stops: Map<string, StopInfo>,
  agencies: Set<string>,
): VehicleRecord[] {
  const feed = rt.FeedMessage.decode(buffer)
  const out: VehicleRecord[] = []

  for (const entity of feed.entity) {
    const vehicle = entity.vehicle
    const position = vehicle?.position
    // A vehicle with no position is not a vehicle we can draw.
    if (!vehicle || !position) continue

    const tripId = vehicle.trip?.tripId ?? ''
    const routeId = vehicle.trip?.routeId ?? ''
    const agency = agencyOf(tripId, routeId)
    if (!agency || !agencies.has(agency)) continue

    const info = trips.get(tripId)
    const stopId = vehicle.stopId ?? undefined
    const reportedAt = Number(vehicle.timestamp ?? 0)

    out.push({
      id: vehicle.vehicle?.id || vehicle.vehicle?.label || entity.id,
      agency,
      lineRef: info?.lineRef ?? stripAgencyPrefix(routeId),
      lineName: info?.lineName || stripAgencyPrefix(routeId),
      destination: info?.destination ?? '',
      directionRef: info?.directionRef ?? (vehicle.trip?.directionId === 1 ? 'IB' : 'OB'),
      lat: position.latitude,
      lon: position.longitude,
      ...(position.bearing != null ? { bearing: position.bearing } : {}),
      ...(position.speed != null ? { speed: position.speed } : {}),
      ...(stopId ? { nextStopId: stopId } : {}),
      ...(stopId && stops.get(stopId) ? { nextStop: stops.get(stopId)!.name } : {}),
      ...(vehicle.occupancyStatus != null
        ? { occupancy: OCCUPANCY[vehicle.occupancyStatus] ?? 'unknown' }
        : {}),
      at: isoSeconds(reportedAt > 0 ? reportedAt : Math.floor(Date.now() / 1000)),
      source: 'gtfsrt',
      confidence: 'high',
    })
  }

  return out
}
