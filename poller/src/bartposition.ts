import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import type { TripInfo } from './gtfs.js'
import {
  pointAtDistance,
  projectOntoShape,
  metresBetween,
  stopDistanceOn,
  type StopInfo,
  type BartGeometryTables,
} from './geo.js'
import type { VehicleRecord } from './gtfsrt.js'

const { transit_realtime: rt } = GtfsRealtimeBindings

// Placing BART trains on the map.
//
// BART is the only operator that publishes no vehicle positions anywhere — not to 511,
// and not in its own GTFS-RT, which 404s on every vehicle-position URL. So a BART train's
// location is not fetched, it is *inferred* from when the feed says it will reach its
// next stops and where those stops sit along the track.
//
// That makes every position here an estimate, and the records say so. A synthesized dot
// gliding smoothly past a platform while the real train sits late is a confident lie, and
// riders calibrate their trust on the first time it burns them.

/** Below this many seconds a segment is treated as instantaneous rather than divided by. */
const MIN_SEGMENT_SECONDS = 1

/** How long to keep showing a train after its last predicted stop. */
const TERMINAL_HOLD_SECONDS = 120

/** Impossible for BART (70 mph ≈ 31 m/s); a higher value means the model is wrong. */
const IMPLAUSIBLE_SPEED_MS = 35

/** Impossible offset from track; likewise a bug rather than a slow day. */
const IMPLAUSIBLE_OFFSET_METRES = 200

/**
 * Cruising speed once a train is up to line speed, and the time it loses accelerating
 * out of one station and braking into the next.
 *
 * Together these turn a segment's *length* into its average speed, which is what makes
 * back-projection work on a network carrying 570 m downtown hops and a 9.4 km Transbay
 * Tube in the same trip. Checked against the live feed: ~12 m/s for the short ones,
 * ~23 m/s for the Tube, against a measured median of 19 m/s across all segments.
 */
const CRUISE_MS = 25
const STATION_OVERHEAD_SECONDS = 25

/**
 * Average speed a train sustains over a segment of this length.
 *
 * Length matters and nothing else needs to: a longer segment spends proportionally less
 * of itself accelerating, so it averages faster. Estimating from a *neighbouring*
 * segment instead — the obvious shortcut — puts a train that has just left West Oakland
 * seven kilometres into the Tube, because the next segment it runs is a short downtown
 * hop at half the speed. That was a real 7 km teleport, caught by comparing consecutive
 * position samples.
 */
export function typicalSpeedFor(lengthMetres: number): number {
  if (lengthMetres <= 0) return 0
  return lengthMetres / (lengthMetres / CRUISE_MS + STATION_OVERHEAD_SECONDS)
}

export interface SynthesisStats {
  trips: number
  placed: number
  atStation: number
  noShape: number
  dropped: number
  /** Canaries. Both are impossible if the code is right, so non-zero is an alarm. */
  implausibleSpeed: number
  implausibleOffset: number
}

interface StopTime {
  stopId: string
  /** Epoch seconds. */
  arrival: number
  departure: number
}

/**
 * The stop timeline for one trip, in order.
 *
 * Both feeds carry an arrival *and* a departure for essentially every BART stop, with a
 * median dwell of 18 seconds. That matters more than any motion model: interpolating
 * across `arrival -> arrival` would show a train gliding out of a station it is still
 * sitting in, which on a two-minute segment is ~170 m of error. Keeping both timestamps
 * makes dwell exact instead of modelled.
 */
function timelineOf(update: GtfsRealtimeBindings.transit_realtime.ITripUpdate): StopTime[] {
  const out: StopTime[] = []
  for (const stu of update.stopTimeUpdate ?? []) {
    if (!stu.stopId) continue
    const arrival = Number(stu.arrival?.time ?? 0)
    const departure = Number(stu.departure?.time ?? 0)
    if (arrival <= 0 && departure <= 0) continue
    out.push({
      stopId: stu.stopId,
      arrival: arrival > 0 ? arrival : departure,
      departure: departure > 0 ? departure : arrival,
    })
  }
  out.sort((a, b) => a.arrival - b.arrival)
  return out
}

interface Placement {
  lat: number
  lon: number
  bearing?: number
  speed: number
  nextStopId: string
  confidence: 'high' | 'low'
  atStation: boolean
}

/**
 * Where the train is now, given its timeline and the track it runs on.
 *
 * Exported for testing: this is the one piece of arithmetic worth pinning down, and it
 * is a pure function of its inputs.
 */
export function placeTrain(
  timeline: StopTime[],
  now: number,
  shapeId: string | undefined,
  tables: BartGeometryTables,
  stops: Map<string, StopInfo>,
): Placement | null {
  if (timeline.length === 0) return null

  const shape = shapeId ? tables.shapes.get(shapeId) : undefined
  const distOf = (stopId: string): number | null =>
    shapeId && shape ? stopDistanceOn(tables, shapeId, stopId) : null

  const first = timeline[0]
  const last = timeline[timeline.length - 1]

  // Past the end of the run. Hold briefly at the terminal, then let it go rather than
  // extrapolating onto track that doesn't exist.
  if (now >= last.departure) {
    if (now > last.departure + TERMINAL_HOLD_SECONDS) return null
    return atStop(last.stopId, 'high')
  }

  /**
   * En route to the first predicted stop — the common case, not an edge case.
   *
   * The feed lists only *upcoming* stops, so a moving train is almost always here: 47 of
   * 58 at a typical moment. Its previous station is therefore never in its own
   * predictions and has to be recovered from the track, then the train walked backwards
   * from the stop it is heading to.
   *
   * Parking it at the upcoming stop instead — which is what "position at the next stop"
   * amounts to — would show almost the entire fleet sitting in stations.
   */
  if (now < first.arrival) {
    const target = distOf(first.stopId)
    if (shape && shapeId && target !== null) {
      // Never further back than the station it came from: if the arithmetic says it is,
      // the train simply hasn't left yet, and the previous platform is the right answer.
      const previous = previousStopDistance(tables, shapeId, target, first.stopId)
      const floor = previous ?? shape[0].dist

      // Speed from the length of the segment it is *on*, not from a neighbouring one.
      const speed = typicalSpeedFor(target - floor)
      const back = speed * (first.arrival - now)
      const distance = Math.max(floor, target - back)

      const point = pointAtDistance(shape, distance)
      if (point) {
        return {
          lat: point.lat,
          lon: point.lon,
          bearing: point.bearing,
          speed: distance <= floor ? 0 : speed,
          nextStopId: first.stopId,
          // Bounded on one side only, and the speed is inferred rather than measured.
          confidence: 'low',
          atStation: distance <= floor,
        }
      }
    }
    return atStop(first.stopId, 'low')
  }

  for (let i = 0; i < timeline.length; i++) {
    const stop = timeline[i]

    // Dwelling. Exact, not modelled — this is the whole reason both timestamps are kept.
    if (now >= stop.arrival && now <= stop.departure) return atStop(stop.stopId, 'high')

    const next = timeline[i + 1]
    if (!next) continue
    if (now <= stop.departure || now >= next.arrival) continue

    // Moving between two stops.
    const span = Math.max(MIN_SEGMENT_SECONDS, next.arrival - stop.departure)
    const fraction = Math.min(1, Math.max(0, (now - stop.departure) / span))

    const from = distOf(stop.stopId)
    const to = distOf(next.stopId)

    if (shape && from !== null && to !== null) {
      const distance = from + (to - from) * fraction
      const point = pointAtDistance(shape, distance)
      if (point) {
        return {
          lat: point.lat,
          lon: point.lon,
          bearing: point.bearing,
          speed: Math.abs(to - from) / span,
          nextStopId: next.stopId,
          confidence: 'high',
          atStation: false,
        }
      }
    }

    // No usable geometry: fall back to a straight line between the two stops. BART runs
    // straight between most station pairs, so this is visually acceptable everywhere
    // except the Oakland Wye and the Berkeley Hills — and it is flagged `low` either way.
    const a = stops.get(stop.stopId)
    const b = stops.get(next.stopId)
    if (a && b) {
      return {
        lat: a.lat + (b.lat - a.lat) * fraction,
        lon: a.lon + (b.lon - a.lon) * fraction,
        speed: metresBetween(a.lat, a.lon, b.lat, b.lon) / span,
        nextStopId: next.stopId,
        confidence: 'low',
        atStation: false,
      }
    }
    return atStop(next.stopId, 'low')
  }

  // Between predictions in a way the loop didn't catch (overlapping times, say).
  return atStop(timeline[timeline.length - 1].stopId, 'low')


  function atStop(stopId: string, confidence: 'high' | 'low'): Placement | null {
    const s = stops.get(stopId)
    if (!s) return null
    return {
      lat: s.lat,
      lon: s.lon,
      speed: 0,
      nextStopId: stopId,
      confidence,
      atStation: true,
    }
  }
}

/**
 * Turns the regional trip-update feed into BART vehicle positions.
 *
 * Deliberately reads the same buffer that produced the departure board rather than
 * BART's own feed. If the dot on the map and the countdown on the board came from
 * different sources they would disagree — a train drawn between two stations while the
 * board says it already left — and one source of truth is worth more than the ten extra
 * trips BART publishes.
 */
export function synthesizeBartVehicles(
  buffer: Uint8Array,
  trips: Map<string, TripInfo>,
  stops: Map<string, StopInfo>,
  tables: BartGeometryTables,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { vehicles: VehicleRecord[]; stats: SynthesisStats } {
  const feed = rt.FeedMessage.decode(buffer)
  const vehicles: VehicleRecord[] = []
  const stats: SynthesisStats = {
    trips: 0,
    placed: 0,
    atStation: 0,
    noShape: 0,
    dropped: 0,
    implausibleSpeed: 0,
    implausibleOffset: 0,
  }

  const at = new Date(nowSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

  for (const entity of feed.entity) {
    const update = entity.tripUpdate
    const tripId = update?.trip?.tripId ?? ''
    if (!update || !tripId.startsWith('BA:')) continue

    stats.trips++

    const timeline = timelineOf(update)
    const shapeId = tables.tripShape.get(tripId)
    if (!shapeId) stats.noShape++

    const placement = placeTrain(timeline, nowSeconds, shapeId, tables, stops)
    if (!placement) {
      stats.dropped++
      continue
    }

    if (placement.speed > IMPLAUSIBLE_SPEED_MS) stats.implausibleSpeed++

    // Cheapest possible alarm: a placed point lies on its polyline by construction, so
    // any real distance from it means the arithmetic above is wrong. Measured by exact
    // projection rather than by sampling vertices — BART's shape points are ~60 m apart,
    // so a sampled nearest-vertex distance reports hundreds of metres for a point that
    // is exactly on the line, and the alarm cries wolf.
    const shape = shapeId ? tables.shapes.get(shapeId) : undefined
    if (shape && !placement.atStation) {
      const hit = projectOntoShape(shape, placement.lat, placement.lon)
      if (hit && hit.offset > IMPLAUSIBLE_OFFSET_METRES) stats.implausibleOffset++
    }

    if (placement.atStation) stats.atStation++
    stats.placed++

    const info = trips.get(tripId)
    vehicles.push({
      id: tripId.slice(3),
      agency: 'BA',
      lineRef: info?.lineRef ?? '',
      lineName: info?.lineName ?? '',
      destination: info?.destination ?? '',
      directionRef: info?.directionRef ?? '',
      lat: placement.lat,
      lon: placement.lon,
      ...(placement.bearing !== undefined ? { bearing: placement.bearing } : {}),
      speed: placement.speed,
      nextStopId: placement.nextStopId,
      ...(stops.get(placement.nextStopId)
        ? { nextStop: stops.get(placement.nextStopId)!.name }
        : {}),
      at,
      source: 'synthesized',
      confidence: placement.confidence,
    })
  }

  return { vehicles, stats }
}

/**
 * Where the previous *station* sits along the shape, in metres.
 *
 * Station, not platform: a station's two-to-four platforms project to within a metre of
 * each other, so a naive "nearest stop before this one" returns the train's own opposite
 * platform and pins it in the station it is leaving. BART's tightest real gap is
 * Embarcadero to Montgomery at ~185 m, which is why this compares station identity
 * rather than applying a distance threshold that would swallow it.
 */
function previousStopDistance(
  tables: BartGeometryTables,
  shapeId: string,
  dist: number,
  targetStopId: string,
): number | null {
  const stops = tables.stopsOnShape.get(shapeId)
  if (!stops) return null
  const here = tables.stationOfStop.get(targetStopId)
  let best: number | null = null
  for (const s of stops) {
    if (s.dist >= dist) continue
    if (here && tables.stationOfStop.get(s.stopId) === here) continue
    if (best === null || s.dist > best) best = s.dist
  }
  return best
}

