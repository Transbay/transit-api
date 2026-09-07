// Polyline geometry, in metres, for placing a train on a track.
//
// Everything here is a pure function of its arguments so it can be tested without a
// feed. The Bay Area spans about half a degree, so distances use a local equirectangular
// projection rather than haversine: at this scale the error is centimetres, and it makes
// projection onto a segment ordinary vector algebra instead of spherical trigonometry.

/** Metres per degree of latitude. Constant enough for one metro area. */
const M_PER_DEG_LAT = 111_320

/** Metres per degree of longitude at the Bay Area's latitude (~37.8°). */
const M_PER_DEG_LON = 88_000

/** One point of a GTFS shape: position plus how far along the shape it lies. */
export interface ShapePoint {
  lat: number
  lon: number
  /** `shape_dist_traveled`, metres from the start of the shape. */
  dist: number
}

export interface ProjectionResult {
  /** Metres along the shape. */
  dist: number
  /** How far the point sat off the line, metres. A sanity check, not an output. */
  offset: number
}

export interface PointOnShape {
  lat: number
  lon: number
  /** Degrees true, 0–360, from the shape's direction of travel. */
  bearing: number
}

function toLocal(lat: number, lon: number, originLat: number, originLon: number): [number, number] {
  return [(lat - originLat) * M_PER_DEG_LAT, (lon - originLon) * M_PER_DEG_LON]
}

/**
 * Where a point sits along a shape.
 *
 * Tries every segment and keeps the nearest, rather than assuming the closest vertex is
 * on the closest segment — it often isn't on a curve. Returns the offset too, so the
 * caller can reject a stop that isn't really on this line at all.
 */
export function projectOntoShape(points: ShapePoint[], lat: number, lon: number): ProjectionResult | null {
  if (points.length === 0) return null
  if (points.length === 1) {
    const [dy, dx] = toLocal(lat, lon, points[0].lat, points[0].lon)
    return { dist: points[0].dist, offset: Math.hypot(dy, dx) }
  }

  let best: ProjectionResult | null = null

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]

    const [aby, abx] = toLocal(b.lat, b.lon, a.lat, a.lon)
    const [apy, apx] = toLocal(lat, lon, a.lat, a.lon)

    const lenSq = aby * aby + abx * abx
    // A zero-length segment (duplicate points) would divide by zero; treat as the vertex.
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (apy * aby + apx * abx) / lenSq))

    const offset = Math.hypot(apy - t * aby, apx - t * abx)
    if (best === null || offset < best.offset) {
      best = { dist: a.dist + t * (b.dist - a.dist), offset }
    }
  }

  return best
}

/**
 * The position and heading at a given distance along a shape.
 *
 * Clamps rather than extrapolating: a train past the end of its shape is a bug
 * elsewhere, and inventing track beyond the terminal would hide it.
 */
export function pointAtDistance(points: ShapePoint[], dist: number): PointOnShape | null {
  if (points.length === 0) return null
  if (points.length === 1) return { lat: points[0].lat, lon: points[0].lon, bearing: 0 }

  const first = points[0]
  const last = points[points.length - 1]
  if (dist <= first.dist) return { ...atVertex(points, 0), bearing: bearingAt(points, 0) }
  if (dist >= last.dist) {
    const i = points.length - 2
    return { lat: last.lat, lon: last.lon, bearing: bearingAt(points, i) }
  }

  // Binary search for the segment containing `dist`; shapes run to ~1,600 points and
  // this is called once per train per cycle.
  let lo = 0
  let hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid].dist <= dist) lo = mid
    else hi = mid
  }

  const a = points[lo]
  const b = points[lo + 1]
  const span = b.dist - a.dist
  const t = span === 0 ? 0 : (dist - a.dist) / span

  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
    bearing: bearingAt(points, lo),
  }
}

function atVertex(points: ShapePoint[], i: number): { lat: number; lon: number } {
  return { lat: points[i].lat, lon: points[i].lon }
}

/** Compass bearing of segment `i`, degrees true. */
export function bearingAt(points: ShapePoint[], i: number): number {
  const a = points[i]
  const b = points[Math.min(i + 1, points.length - 1)]
  const north = (b.lat - a.lat) * M_PER_DEG_LAT
  const east = (b.lon - a.lon) * M_PER_DEG_LON
  if (north === 0 && east === 0) return 0
  const deg = (Math.atan2(east, north) * 180) / Math.PI
  return (deg + 360) % 360
}

/** Straight-line metres between two coordinates. */
export function metresBetween(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const [dy, dx] = toLocal(lat1, lon1, lat2, lon2)
  return Math.hypot(dy, dx)
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

/**
 * Shapes are stored as a flat number array rather than objects.
 *
 * 27,893 BART points is ~700 KB packed this way; as `{lat,lon,dist}` objects the JSON
 * is more than twice that, for data read once a day and held in memory all day.
 * Coordinates keep 6 decimals (~0.1 m) and distances are whole metres.
 */
export function packShape(points: ShapePoint[]): string {
  const flat: number[] = []
  for (const p of points) {
    flat.push(Number(p.lat.toFixed(6)), Number(p.lon.toFixed(6)), Math.round(p.dist))
  }
  return JSON.stringify(flat)
}

export function unpackShape(packed: string): ShapePoint[] {
  const flat = JSON.parse(packed) as number[]
  const out: ShapePoint[] = []
  for (let i = 0; i + 2 < flat.length; i += 3) {
    out.push({ lat: flat[i], lon: flat[i + 1], dist: flat[i + 2] })
  }
  return out
}

/**
 * Replaces each point's `dist` with true cumulative metres along the polyline.
 *
 * GTFS's `shape_dist_traveled` is explicitly unit-agnostic — the spec lets a producer
 * use whatever it likes, and the 511 regional feed uses roughly 3.05 m per unit for
 * BART. Self-consistent distances are enough to *place* a train, so this is easy to
 * miss; it is not enough to state its speed, and a wrong speed in m/s reads as
 * perfectly plausible.
 *
 * Measuring the geometry removes the assumption entirely. Input must already be in
 * travel order.
 */
export function remeasureInMetres(points: ShapePoint[]): ShapePoint[] {
  if (points.length === 0) return []
  const out: ShapePoint[] = [{ lat: points[0].lat, lon: points[0].lon, dist: 0 }]
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += metresBetween(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon)
    out.push({ lat: points[i].lat, lon: points[i].lon, dist: total })
  }
  return out
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Field separator inside a packed Redis value. Never appears in GTFS text.
 *
 * Defined here rather than in `gtfs.ts` so the lookup below stays pure — the position
 * maths must be testable without booting config or Redis.
 */
export const US = '\x1f'

export interface StopInfo {
  name: string
  lat: number
  lon: number
}

export interface BartStationInfo {
  abbr: string
  name: string
  lat: number
  lon: number
  /** GTFS platform stop ids at this station. */
  stopIds: string[]
}

export interface BartGeometryTables {
  shapes: Map<string, ShapePoint[]>
  /** `shapeId\x1fstopId` -> metres along that shape. */
  stopDist: Map<string, number>
  /**
   * Each shape's stops in order of travel.
   *
   * Needed because the feed lists only *upcoming* stops, so a train's previous station —
   * the one it is travelling away from — is never in its own predictions and has to be
   * recovered from the track.
   */
  stopsOnShape: Map<string, { stopId: string; dist: number }[]>
  tripShape: Map<string, string>
  stations: Map<string, BartStationInfo>
  /**
   * Platform stop id -> its station's abbreviation.
   *
   * A station's two-to-four platforms project to within a metre of each other, so "the
   * stop before this one" has to mean the previous *station*. Without this a train's
   * previous stop resolves to its own opposite platform and it is pinned in the station
   * it is leaving.
   */
  stationOfStop: Map<string, string>
}

/** Metres along `shapeId` at which `stopId` sits, or null if it isn't on that shape. */
export function stopDistanceOn(
  tables: BartGeometryTables,
  shapeId: string,
  stopId: string,
): number | null {
  const d = tables.stopDist.get(`${shapeId}${US}${stopId}`)
  return d === undefined ? null : d
}
