import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, open as openFile, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createInterface } from 'node:readline'
import yauzl from 'yauzl'
import { config } from './config.js'
import { redis } from './redis.js'
import { fetchUpstreamRaw } from './upstream.js'
import { lineBadge, resolveRouteDestinations } from './names.js'
import {
  projectOntoShape,
  packShape,
  unpackShape,
  metresBetween,
  remeasureInMetres,
  stopDistanceOn,
  US,
  type ShapePoint,
  type StopInfo,
  type BartStationInfo,
  type BartGeometryTables,
} from './geo.js'

// The geometry types and the pure stop lookup live in `geo.ts`, so the position maths
// can be tested without booting config or Redis. Re-exported here because this is where
// callers expect to find them.
export { stopDistanceOn, type StopInfo, type BartStationInfo, type BartGeometryTables }
import { fetchBartStations } from './bart.js'

/** The static half of the feed: what a trip *is*, loaded once a day. */

/**
 * Trims 511's web page off the end of the archive.
 *
 * Their export endpoint is an ASP.NET page that writes the zip to the response and
 * then lets the page render anyway, so the body is a valid zip followed by ~700 bytes
 * of `<!DOCTYPE html>…`. Every zip reader that validates the end-of-central-directory
 * record — yauzl included — refuses the file outright ("Invalid comment length").
 *
 * The fix is exact rather than heuristic: the EOCD record declares its own comment
 * length, so the archive's true end is `eocd + 22 + commentLength`. Anything past that
 * is not ours and is discarded.
 *
 * Worth knowing: that trailing HTML embeds the API key in a form action. It never
 * reaches a log because the archive lives in a temp file that is deleted in a
 * `finally`, and nothing here decodes those bytes — but if you ever add debug output
 * around this function, do not dump the tail of the file.
 */
export async function trimTrailingBytes(zipPath: string): Promise<void> {
  const handle = await openFile(zipPath, 'r')
  let size: number
  let tail: Buffer
  try {
    size = (await handle.stat()).size
    // A zip comment is at most 65535 bytes, so the EOCD is always inside the last
    // 64 KB + 22. Reading the whole 60 MB file to find it would defeat the point.
    const window = Math.min(size, 65_557)
    tail = Buffer.alloc(window)
    await handle.read(tail, 0, window, size - window)
  } finally {
    await handle.close()
  }

  const eocd = tail.lastIndexOf('PK', undefined, 'binary')
  if (eocd < 0) return // Not a zip we recognise; let yauzl produce the real error.

  const commentLength = tail.readUInt16LE(eocd + 20)
  const properEnd = size - window_(tail) + eocd + 22 + commentLength
  if (properEnd < size) {
    await truncate(zipPath, properEnd)
    console.info(`[gtfs] trimmed ${size - properEnd} trailing bytes from the archive`)
  }
}

/** The window length used above, kept as a function so the arithmetic reads cleanly. */
function window_(tail: Buffer): number {
  return tail.length
}

const TRIP_KEY = 'gtfs:trip'
const STOP_KEY = 'gtfs:stop'
const VERSION_KEY = 'gtfs:version'

// BART geometry lives under its own keys rather than as extra fields on `gtfs:trip`.
// That hash is 94k entries and is read whole every 15 seconds; BART-only data has no
// business riding along on it.
const BART_SHAPE_KEY = 'gtfs:bart:shape'
const BART_STOPDIST_KEY = 'gtfs:bart:stopdist'
const BART_TRIPSHAPE_KEY = 'gtfs:bart:tripshape'
const BART_STATION_KEY = 'gtfs:bart:station'

/** The regional feed qualifies every BART id with this. */
const BART = 'BA:'

/** A stop further than this from a shape isn't on that line. */
const STOP_ON_SHAPE_METRES = 150

/** Platforms of one station. Measured at 80 m worst case across all 50 stations. */
const STATION_RADIUS_METRES = 250

/** Redis caps how much one HSET should carry; 94k trips go up in chunks. */
const HSET_CHUNK = 1000

export interface TripInfo {
  /** Badge text: "N", "51B", "38R", "Local Weekday". */
  lineName: string
  /** Simplified destination: "Caltrain", "Rockridge". */
  destination: string
  /** SIRI-style direction, derived from GTFS `direction_id`. */
  directionRef: string
  /** The agency-stripped route id the client uses as `LineRef` ("AC:12" -> "12"). */
  lineRef: string
  /** `trip_short_name` — the train number, where an operator publishes one. */
  shortName: string
}


// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** A minimal RFC 4180 splitter. */
export function splitCSV(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else quoted = false
      } else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * Streams one CSV entry out of the zip, a row at a time.
 *
 * `prefilter` is tested against the raw line before it is split, which is what makes
 * reading `shapes.txt` affordable: 98% of its 1.4M rows are rejected without ever
 * allocating a cell array. It is only applied when `firstColumn` matches the header,
 * so a future column reorder degrades to a full parse instead of silently reading
 * nothing.
 */
export async function readCSV(
  zipPath: string,
  entryName: string,
  onRow: (row: Record<string, string>) => void,
  opts?: { prefilter?: (line: string) => boolean; firstColumn?: string },
): Promise<number> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, z) =>
      err ? reject(err) : resolve(z),
    )
  })

  try {
    const stream = await new Promise<NodeJS.ReadableStream | null>((resolve, reject) => {
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== entryName) {
          // The whole point: `stop_times.txt` and `shapes.txt` are passed over here,
          // never inflated.
          zip.readEntry()
          return
        }
        zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s!)))
      })
      zip.on('end', () => resolve(null))
      zip.on('error', reject)
      zip.readEntry()
    })

    if (!stream) throw new Error(`${entryName} not found in regional GTFS archive`)

    let header: string[] | null = null
    let prefilter = opts?.prefilter
    let count = 0
    for await (const raw of createInterface({ input: stream, crlfDelay: Infinity })) {
      // The first line carries a UTF-8 BOM, which would make the first column name
      // "﻿route_id" and every lookup of it return undefined.
      const line = header === null ? raw.replace(/^﻿/, '') : raw
      if (!line) continue
      if (header === null) {
        header = splitCSV(line)
        // Only trust the fast path if the column we filter on really is first.
        if (opts?.prefilter && opts.firstColumn && header[0] !== opts.firstColumn) {
          console.warn(
            `[gtfs] ${entryName}: expected '${opts.firstColumn}' first but found ` +
              `'${header[0]}'; parsing every row instead of prefiltering`,
          )
          prefilter = undefined
        }
        continue
      }
      if (prefilter && !prefilter(line)) continue
      const cells = splitCSV(line)
      const row: Record<string, string> = {}
      for (let i = 0; i < header.length; i++) row[header[i]] = cells[i] ?? ''
      onRow(row)
      count++
    }
    return count
  } finally {
    zip.close()
  }
}

/**
 * The same stream, without allocating an object per row.
 *
 * `readCSV` builds a `Record<string, string>` for every surviving row, which is exactly
 * the right shape for `routes.txt` (a few thousand rows) and exactly the wrong one for
 * `stop_times.txt`. Filtered to five agencies that file still yields on the order of two
 * and a half million rows, and two and a half million ten-key objects is twenty to forty
 * seconds of pure allocation and garbage collection — inside a process that is also
 * supposed to be answering departures every fifteen seconds.
 *
 * So: resolve the column indices once against the header, then hand the caller the raw
 * cells. Same parsing, same prefilter, roughly a quarter of the time and none of the
 * garbage.
 */
export async function readCSVPositional(
  zipPath: string,
  entryName: string,
  columns: string[],
  onRow: (cells: string[], index: (name: string) => number) => void | Promise<void>,
  opts?: { prefilter?: (line: string) => boolean; firstColumn?: string },
): Promise<number> {
  let indices = new Map<string, number>()
  const index = (name: string) => indices.get(name) ?? -1
  let resolved = false

  return readCSVRaw(
    zipPath,
    entryName,
    (cells, header) => {
      if (!resolved) {
        indices = new Map(columns.map((c) => [c, header.indexOf(c)]))
        const missing = columns.filter((c) => indices.get(c) === -1)
        if (missing.length > 0) {
          console.warn(`[gtfs] ${entryName}: missing column(s) ${missing.join(', ')}`)
        }
        resolved = true
      }
      return onRow(cells, index)
    },
    opts,
  )
}

/** The shared streaming core. Splits, never allocates a row object. */
async function readCSVRaw(
  zipPath: string,
  entryName: string,
  onRow: (cells: string[], header: string[]) => void | Promise<void>,
  opts?: { prefilter?: (line: string) => boolean; firstColumn?: string },
): Promise<number> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, z) =>
      err ? reject(err) : resolve(z),
    )
  })

  try {
    const stream = await new Promise<NodeJS.ReadableStream | null>((resolve, reject) => {
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== entryName) {
          zip.readEntry()
          return
        }
        zip.openReadStream(entry, (err, st) => (err ? reject(err) : resolve(st!)))
      })
      zip.on('end', () => resolve(null))
      zip.on('error', reject)
      zip.readEntry()
    })

    if (!stream) throw new Error(`${entryName} not found in regional GTFS archive`)

    let header: string[] | null = null
    let prefilter = opts?.prefilter
    let count = 0
    for await (const raw of createInterface({ input: stream, crlfDelay: Infinity })) {
      const line = header === null ? raw.replace(/^\ufeff/, '') : raw
      if (!line) continue
      if (header === null) {
        header = splitCSV(line)
        if (opts?.prefilter && opts.firstColumn && header[0] !== opts.firstColumn) {
          // The prefilter tests the raw line, which is only sound if the column it keys on
          // really is first. Degrading to a full parse is slow; silently reading nothing
          // would be worse.
          console.warn(
            `[gtfs] ${entryName}: expected '${opts.firstColumn}' first but found ` +
              `'${header[0]}'; parsing every row instead of prefiltering`,
          )
          prefilter = undefined
        }
        continue
      }
      if (prefilter && !prefilter(line)) continue
      // Awaited only when the callback actually returns something. A caller that writes in
      // batches needs to apply back-pressure a few hundred times across two and a half
      // million rows; awaiting every row instead would add two and a half million
      // microtask hops to a parse that is already the slowest thing in the service.
      const pending = onRow(splitCSV(line), header)
      if (pending) await pending
      count++
    }
    return count
  } finally {
    zip.close()
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * GTFS `direction_id` is 0 or 1 with no fixed meaning; SIRI used "IB"/"OB" and the
 * app's `DirectionName` still keys off those. Mapping 0 to outbound matches how the
 * previous SIRI feed labelled the same trips, so saved per-direction stops keep the
 * direction they were saved with.
 */
function directionRef(directionId: string): string {
  return directionId === '1' ? 'IB' : 'OB'
}

/** "AC:12" -> "12". The client's `LineRef`, and what `LineStyles` keys badges on. */
function stripAgency(id: string): string {
  const i = id.indexOf(':')
  return i >= 0 ? id.slice(i + 1) : id
}

/**
 * Downloads the regional GTFS and rebuilds the static tables.
 *
 * Returns the number of trips indexed, or throws. Callers treat a throw as "keep
 * yesterday's tables" — stale names are survivable, missing ones are not.
 */
export async function loadStaticGTFS(): Promise<{
  trips: number
  stops: number
  bartShapes: number
  bartStations: number
}> {
  const dir = await mkdtemp(join(tmpdir(), 'baytransit-gtfs-'))
  const zipPath = join(dir, 'regional.zip')

  try {
    // One request per day against the same budget as everything else.
    const body = await fetchUpstreamRaw('datafeeds', { operator_id: 'RG' })
    await pipeline(Readable.fromWeb(body as never), createWriteStream(zipPath))
    await trimTrailingBytes(zipPath)

    // --- routes: id -> badge -------------------------------------------------
    const routeBadge = new Map<string, string>()
    await readCSV(zipPath, 'routes.txt', (r) => {
      routeBadge.set(
        r.route_id,
        lineBadge(r.route_short_name, r.route_long_name, r.route_id),
      )
    })

    // --- trips: collect, then name -------------------------------------------
    // Destinations are resolved per route rather than per trip, because
    // `resolveRouteDestinations` can only detect an ambiguous simplification by
    // seeing every headsign on the route at once. So: gather first, name second.
    const bartTripShape = new Map<string, string>()

    interface RawTrip {
      tripId: string
      routeId: string
      headsign: string
      dir: string
      shortName: string
    }
    const raw: RawTrip[] = []
    const headsignsByRoute = new Map<string, Set<string>>()

    await readCSV(zipPath, 'trips.txt', (t) => {
      const headsign = (t.trip_headsign ?? '').trim()
      raw.push({
        tripId: t.trip_id,
        routeId: t.route_id,
        headsign,
        dir: t.direction_id,
        shortName: (t.trip_short_name ?? '').trim(),
      })
      // BART needs trip -> shape to place a train on track; nobody else does.
      if (t.route_id.startsWith(BART) && t.shape_id) bartTripShape.set(t.trip_id, t.shape_id)
      if (!headsign) return
      let set = headsignsByRoute.get(t.route_id)
      if (!set) headsignsByRoute.set(t.route_id, (set = new Set()))
      set.add(headsign)
    })

    const destByRoute = new Map<string, Map<string, string>>()
    for (const [routeId, headsigns] of headsignsByRoute) {
      destByRoute.set(routeId, resolveRouteDestinations(headsigns))
    }

    const tripFields: string[] = []
    for (const t of raw) {
      const info: TripInfo = {
        lineName: routeBadge.get(t.routeId) ?? stripAgency(t.routeId),
        destination: destByRoute.get(t.routeId)?.get(t.headsign) ?? t.headsign,
        directionRef: directionRef(t.dir),
        lineRef: stripAgency(t.routeId),
        shortName: t.shortName,
      }
      tripFields.push(
        t.tripId,
        [info.lineName, info.destination, info.directionRef, info.lineRef, info.shortName].join(US),
      )
    }

    // --- stops: id -> name, position -----------------------------------------
    const stopFields: string[] = []
    // Which stops are BART's, from the feed rather than from geography. The regional
    // archive tags every stop with an agency-qualified `zone_id`, and BART's 265 cover
    // every stop id the live BA feed references. Choosing them by proximity to a station
    // instead would sweep up every bus stop outside the entrance — and then "the previous
    // station" resolves to a bus stop a metre away, which silently pins the whole fleet
    // inside stations.
    const bartStopIds = new Set<string>()
    await readCSV(zipPath, 'stops.txt', (s) => {
      const name = (s.stop_name ?? '').trim()
      if (!name) return
      if ((s.zone_id ?? '').startsWith(BART)) bartStopIds.add(s.stop_id)
      stopFields.push(s.stop_id, [name, s.stop_lat ?? '', s.stop_lon ?? ''].join(US))
    })

    // --- BART geometry -------------------------------------------------------
    // BART is the only operator with no published vehicle positions, so its trains
    // have to be placed by interpolating along the track. That needs the shapes, which
    // are 60 MB of the archive we otherwise skip entirely.
    const bart = await buildBartGeometry(zipPath, bartTripShape, stopFields, bartStopIds)

    await writeTables(tripFields, stopFields, bart)

    return {
      trips: tripFields.length / 2,
      stops: stopFields.length / 2,
      bartShapes: bart.shapeFields.length / 2,
      bartStations: bart.stationFields.length / 2,
    }
  } finally {
    // The zip is 60 MB; a container that leaks one a day fills its disk in a week.
    await rm(dir, { recursive: true, force: true })
  }
}

interface BartGeometry {
  shapeFields: string[]
  stopDistFields: string[]
  tripShapeFields: string[]
  stationFields: string[]
}

/**
 * Reads BART's track geometry and builds the tables that let a train be placed on it.
 *
 * Never throws: BART geometry is an enhancement, and losing it must not cost the other
 * 23 operators their nightly name tables. A failure here means BART trains fall back to
 * straight-line positions, which is visible on `/health` as `bartShapes: 0`.
 */
async function buildBartGeometry(
  zipPath: string,
  tripShape: Map<string, string>,
  stopFields: string[],
  bartStopIds: Set<string>,
): Promise<BartGeometry> {
  const empty: BartGeometry = {
    shapeFields: [],
    stopDistFields: [],
    tripShapeFields: [],
    stationFields: [],
  }

  try {
    // ~27,900 of 1,395,000 rows survive the prefilter.
    const byShape = new Map<string, ShapePoint[]>()
    await readCSV(
      zipPath,
      'shapes.txt',
      (r) => {
        const lat = Number(r.shape_pt_lat)
        const lon = Number(r.shape_pt_lon)
        const dist = Number(r.shape_dist_traveled)
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(dist)) return
        let pts = byShape.get(r.shape_id)
        if (!pts) byShape.set(r.shape_id, (pts = []))
        pts.push({ lat, lon, dist })
      },
      { prefilter: (line) => line.startsWith(BART), firstColumn: 'shape_id' },
    )

    if (byShape.size === 0) {
      console.warn('[gtfs] no BART shapes found; trains will fall back to straight lines')
      return empty
    }

    // `shape_dist_traveled` is NOT metres in this feed: measured against the polyline
    // itself, one unit is ~3.05 m, consistently across all 28 BART shapes. Self-consistent
    // distances are enough to *place* a train — which is why this hid — but not to state
    // its speed, and 20 mph for BART is the kind of wrong that looks plausible.
    //
    // Remeasured in place, before anything reads these points, so the packed shapes and
    // the stop projections below cannot end up on different scales.
    const shapeFields: string[] = []
    for (const [id, pts] of byShape) {
      // The archive is usually ordered, but nothing guarantees it and an unsorted
      // polyline silently produces nonsense positions.
      pts.sort((a, b) => a.dist - b.dist)
      byShape.set(id, remeasureInMetres(pts))
    }
    for (const [id, pts] of byShape) shapeFields.push(id, packShape(pts))

    const position = new Map<string, [number, number]>()
    for (let i = 0; i < stopFields.length; i += 2) {
      if (!bartStopIds.has(stopFields[i])) continue
      const [, latRaw, lonRaw] = stopFields[i + 1].split(US)
      const lat = Number(latRaw)
      const lon = Number(lonRaw)
      if (Number.isFinite(lat) && Number.isFinite(lon)) position.set(stopFields[i], [lat, lon])
    }

    const stationFields = buildBartStations(await fetchStations(), position)

    // ~265 platforms x 28 shapes, once a day — the expensive step, which is exactly why
    // it lives here and not in the 15-second cycle.
    const stopDistFields: string[] = []
    for (const [stopId, [lat, lon]] of position) {
      for (const [shapeId, pts] of byShape) {
        const hit = projectOntoShape(pts, lat, lon)
        if (hit && hit.offset <= STOP_ON_SHAPE_METRES) {
          stopDistFields.push(`${shapeId}${US}${stopId}`, String(Math.round(hit.dist)))
        }
      }
    }

    const tripShapeFields: string[] = []
    for (const [tripId, shapeId] of tripShape) tripShapeFields.push(tripId, shapeId)

    console.info(
      `[gtfs] BART: ${byShape.size} shapes, ${shapeFields.length / 2} packed, ` +
        `${stopDistFields.length / 2} stop projections, ${stationFields.length / 2} stations`,
    )
    return { shapeFields, stopDistFields, tripShapeFields, stationFields }
  } catch (err) {
    console.error('[gtfs] BART geometry failed:', (err as Error).message)
    return empty
  }
}

/**
 * Maps BART's station abbreviations to GTFS platform stops, geographically.
 *
 * Not by name: BART writes "Montgomery St." where GTFS writes "Montgomery Street", and
 * "SFIA" for "San Francisco International Airport" — 10 of 49 stations fail a name
 * match. BART publishes `gtfs_latitude`/`gtfs_longitude` meant to line up with GTFS,
 * and they do: every station lands within 80 m of its platforms.
 */
async function fetchStations() {
  try {
    return await fetchBartStations()
  } catch (err) {
    console.warn('[gtfs] BART station list unavailable:', (err as Error).message)
    return []
  }
}

/**
 * Maps BART's station abbreviations to its GTFS platforms, geographically.
 *
 * Not by name: BART writes "Montgomery St." where GTFS writes "Montgomery Street", and
 * "SFIA" for "San Francisco International Airport" — 10 of 49 stations fail a name match.
 * The coordinates BART publishes are labelled `gtfs_*` and line up within 80 m.
 */
function buildBartStations(
  stations: { abbr: string; name: string; lat: number; lon: number }[],
  bartPositions: Map<string, [number, number]>,
): string[] {
  const out: string[] = []
  for (const st of stations) {
    const matched: string[] = []
    for (const [stopId, [lat, lon]] of bartPositions) {
      if (metresBetween(st.lat, st.lon, lat, lon) <= STATION_RADIUS_METRES) matched.push(stopId)
    }
    if (matched.length === 0) {
      console.warn(`[gtfs] BART station ${st.abbr} matched no GTFS stop`)
      continue
    }
    out.push(st.abbr, [st.name, st.lat, st.lon, matched.join(',')].join(US))
  }
  return out
}

/** Swaps every table into place atomically. */
async function writeTables(
  tripFields: string[],
  stopFields: string[],
  bart: BartGeometry,
): Promise<void> {
  const staged: [string, string[]][] = [
    [TRIP_KEY, tripFields],
    [STOP_KEY, stopFields],
    [BART_SHAPE_KEY, bart.shapeFields],
    [BART_STOPDIST_KEY, bart.stopDistFields],
    [BART_TRIPSHAPE_KEY, bart.tripShapeFields],
    [BART_STATION_KEY, bart.stationFields],
  ]

  const swap = redis.pipeline()
  for (const [key, fields] of staged) {
    const staging = `${key}:staging`
    await redis.del(staging)
    // An empty table would make RENAME fail on a missing key; leave yesterday's in
    // place instead, which is the right answer for geometry that failed to load.
    if (fields.length === 0) continue
    for (let i = 0; i < fields.length; i += HSET_CHUNK * 2) {
      await redis.hset(staging, ...fields.slice(i, i + HSET_CHUNK * 2))
    }
    swap.rename(staging, key)
  }

  await swap.set(VERSION_KEY, new Date().toISOString()).exec()
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function unpackTrip(packed: string): TripInfo {
  const [lineName, destination, directionRef, lineRef, shortName] = packed.split(US)
  return { lineName, destination, directionRef, lineRef, shortName: shortName ?? '' }
}

/**
 * The name tables, memoised on the feed version.
 *
 * These are ~94,000 and ~30,000 fields and they change once a day. Re-pulling them from
 * Redis every fifteen seconds moved several megabytes a cycle — hundreds of kilobytes a
 * second, sustained, forever — and rebuilt two large Maps for bytes that were identical to
 * the ones already in memory. `loadBartGeometry` below has always been memoised this way;
 * these two simply never were.
 */
let tripTableCache: { version: string; table: Map<string, TripInfo> } | null = null
let stopTableCache: { version: string; table: Map<string, StopInfo> } | null = null

async function feedVersion(): Promise<string> {
  return (await redis.get(VERSION_KEY)) ?? ''
}

/** Loads the whole trip table into memory. Cheap after the first call each day. */
export async function loadTripTable(): Promise<Map<string, TripInfo>> {
  const version = await feedVersion()
  if (tripTableCache && tripTableCache.version === version) return tripTableCache.table

  const all = await redis.hgetall(TRIP_KEY)
  const out = new Map<string, TripInfo>()
  for (const [tripId, packed] of Object.entries(all)) out.set(tripId, unpackTrip(packed))
  tripTableCache = { version, table: out }
  return out
}

export async function loadStopTable(): Promise<Map<string, StopInfo>> {
  const version = await feedVersion()
  if (stopTableCache && stopTableCache.version === version) return stopTableCache.table

  const all = await redis.hgetall(STOP_KEY)
  const out = new Map<string, StopInfo>()
  for (const [stopId, packed] of Object.entries(all)) {
    const [name, lat, lon] = packed.split(US)
    out.set(stopId, { name, lat: Number(lat), lon: Number(lon) })
  }
  stopTableCache = { version, table: out }
  return out
}

// ---------------------------------------------------------------------------
// BART geometry
// ---------------------------------------------------------------------------



// Memoised on the feed version. These change once a day; re-pulling ~700 KB every 15
// seconds to get identical bytes is pure waste.
let geometryCache: { version: string; tables: BartGeometryTables } | null = null

export async function loadBartGeometry(): Promise<BartGeometryTables> {
  const version = (await redis.get(VERSION_KEY)) ?? ''
  if (geometryCache && geometryCache.version === version) return geometryCache.tables

  const [shapesRaw, stopDistRaw, tripShapeRaw, stationsRaw] = await Promise.all([
    redis.hgetall(BART_SHAPE_KEY),
    redis.hgetall(BART_STOPDIST_KEY),
    redis.hgetall(BART_TRIPSHAPE_KEY),
    redis.hgetall(BART_STATION_KEY),
  ])

  const shapes = new Map<string, ShapePoint[]>()
  for (const [id, packed] of Object.entries(shapesRaw)) shapes.set(id, unpackShape(packed))

  const stopDist = new Map<string, number>()
  const stopsOnShape = new Map<string, { stopId: string; dist: number }[]>()
  for (const [k, v] of Object.entries(stopDistRaw)) {
    const dist = Number(v)
    stopDist.set(k, dist)
    const [shapeId, stopId] = k.split(US)
    let list = stopsOnShape.get(shapeId)
    if (!list) stopsOnShape.set(shapeId, (list = []))
    list.push({ stopId, dist })
  }
  for (const list of stopsOnShape.values()) list.sort((a, b) => a.dist - b.dist)

  const tripShape = new Map<string, string>(Object.entries(tripShapeRaw))

  const stations = new Map<string, BartStationInfo>()
  const stationOfStop = new Map<string, string>()
  for (const [abbr, packed] of Object.entries(stationsRaw)) {
    const [name, lat, lon, ids] = packed.split(US)
    const stopIds = ids ? ids.split(',') : []
    stations.set(abbr, { abbr, name, lat: Number(lat), lon: Number(lon), stopIds })
    for (const id of stopIds) stationOfStop.set(id, abbr)
  }

  const tables = { shapes, stopDist, stopsOnShape, tripShape, stations, stationOfStop }
  geometryCache = { version, tables }
  return tables
}


/** When the static tables were last rebuilt, for `/health`. */
export async function staticStatus(): Promise<{
  version: string | null
  trips: number
  bartShapes: number
  bartStations: number
}> {
  const [version, trips, bartShapes, bartStations] = await Promise.all([
    redis.get(VERSION_KEY),
    redis.hlen(TRIP_KEY),
    redis.hlen(BART_SHAPE_KEY),
    redis.hlen(BART_STATION_KEY),
  ])
  // bartShapes dropping to 0 degrades trains to straight-line positions, which *looks*
  // fine on a map — so it has to be visible somewhere.
  return { version, trips, bartShapes, bartStations }
}

/** True when the tables are missing entirely — the poller can do nothing without them. */
export async function staticTablesMissing(): Promise<boolean> {
  return (await redis.hlen(TRIP_KEY)) === 0
}

/** Milliseconds between static refreshes. */
export function staticRefreshIntervalMs(): number {
  return config.poll.staticRefreshHours * 3_600_000
}
