import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { config } from './config.js'
import { timepointsAreInformative, type TripSchedule } from './schedule.js'
import { shiftDate, localDate, type ServiceDate } from './servicedate.js'

/**
 * The warehouse.
 *
 * Everything historical lives here, and **nothing on the live departures path touches
 * it.** That is the one rule this file exists to enforce: `available()` is false when
 * there is no `DATABASE_URL`, every call returns an empty result rather than throwing, and
 * a Postgres outage costs learning rather than availability. A widget on somebody's phone
 * must never be able to tell whether this database is up.
 *
 * The corollary is that a Postgres failure is *quiet*, which is its own hazard — so every
 * failure increments a counter that `/health` reports, and the counters are the thing to
 * alert on.
 */

const here = dirname(fileURLToPath(import.meta.url))

/** Exactly `YYYY-MM-DD`, and a real date. The only shape allowed near interpolated SQL. */
function isPlainDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const t = Date.parse(`${s}T12:00:00Z`)
  return Number.isFinite(t)
}

let pool: pg.Pool | null = null
let ready = false

export const warehouseStats = {
  queries: 0,
  failures: 0,
  lastFailure: null as string | null,
  migratedTo: 0,
  tripsWritten: 0,
  profilesWritten: 0,
}

export function available(): boolean {
  return pool !== null && ready
}

export function configured(): boolean {
  return Boolean(config.warehouse.url)
}

/**
 * Opens the pool and brings the schema up to date.
 *
 * Never throws. A warehouse that cannot be reached at boot is a service that runs without
 * one, which is a supported configuration — the alternative, refusing to start, would take
 * the departures feed down over a database the departures feed does not use.
 */
export async function connect(): Promise<void> {
  if (!config.warehouse.url) {
    console.info('[warehouse] no DATABASE_URL; history and profiles are disabled')
    return
  }

  try {
    pool = new pg.Pool({
      connectionString: config.warehouse.url,
      max: config.warehouse.poolSize,
      // A slow warehouse must not become a slow poll cycle. Everything here is batch work
      // on a timer, so failing fast and retrying next tick is strictly better than waiting.
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
    })
    pool.on('error', (err) => {
      warehouseStats.failures++
      warehouseStats.lastFailure = err.message
      console.error('[warehouse] pool error:', err.message)
    })

    await pool.query('SELECT 1')
    if (config.warehouse.migrate) await migrate()
    ready = true
    console.info('[warehouse] connected')
  } catch (err) {
    warehouseStats.failures++
    warehouseStats.lastFailure = (err as Error).message
    console.error('[warehouse] unavailable, continuing without it:', (err as Error).message)
    ready = false
  }
}

export async function close(): Promise<void> {
  const p = pool
  pool = null
  ready = false
  await p?.end().catch(() => undefined)
}

/** Runs a query, or returns null if the warehouse is not usable. Never throws. */
async function run<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<T> | null> {
  if (!pool) return null
  try {
    warehouseStats.queries++
    return await pool.query<T>(text, values)
  } catch (err) {
    warehouseStats.failures++
    warehouseStats.lastFailure = (err as Error).message
    console.error('[warehouse] query failed:', (err as Error).message)
    return null
  }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * Plain numbered SQL files, applied in order, recorded in a table.
 *
 * No ORM and no migration framework: this codebase writes its own Redis commands and its
 * own SQL, the queries here are analytical rather than CRUD, and a framework would be more
 * code than the thing it manages.
 */
async function migrate(): Promise<void> {
  await pool!.query(
    'CREATE TABLE IF NOT EXISTS schema_version (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  )
  const applied = await pool!.query<{ version: number }>('SELECT version FROM schema_version')
  const done = new Set(applied.rows.map((r) => r.version))

  // `.sql` files are not compiled, so they sit at the repo root beside `dist/` -- the same
  // relative position `certs/` occupies for `attest.ts`.
  const dir = join(here, '..', 'migrations')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()

  for (const file of files) {
    const version = Number(file.slice(0, 3))
    if (!Number.isFinite(version) || done.has(version)) continue
    const sql = await readFile(join(dir, file), 'utf8')

    const client = await pool!.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_version (version) VALUES ($1)', [version])
      await client.query('COMMIT')
      warehouseStats.migratedTo = version
      console.info(`[warehouse] applied ${file}`)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw new Error(`migration ${file} failed: ${(err as Error).message}`)
    } finally {
      client.release()
    }
  }
}

// ---------------------------------------------------------------------------
// Partitions
// ---------------------------------------------------------------------------

/**
 * Keeps a partition ready for the days we are about to write, and drops the ones past
 * retention.
 *
 * The default partition exists so a write can never fail for want of one; this just keeps
 * it empty, because a default partition that accumulates rows cannot be detached cheaply
 * and quietly reintroduces the problem partitioning was meant to solve.
 */
export async function rollPartitions(today: ServiceDate): Promise<void> {
  if (!available()) return
  if (!isPlainDate(today)) {
    console.error(`[warehouse] refusing to roll partitions for ${today}`)
    return
  }

  for (let d = -1; d <= 2; d++) {
    const day = shiftDate(today, d)
    const next = shiftDate(day, 1)
    if (!isPlainDate(day) || !isPlainDate(next)) continue
    const name = `trip_observation_${day.replace(/-/g, '')}`
    // Postgres does not accept bind parameters in DDL, so these are interpolated -- which
    // is only acceptable because `isPlainDate` has just proved they are `YYYY-MM-DD` and
    // nothing else. They come from our own date arithmetic, never from a request, and the
    // check is here so that stays true if a caller ever changes.
    await run(
      `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF trip_observation
         FOR VALUES FROM ('${day}') TO ('${next}')`,
    )
  }

  const cutoff = shiftDate(today, -config.profile.retentionDays)
  const old = await run<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE tablename LIKE 'trip_observation_2%' AND tablename < $1`,
    [`trip_observation_${cutoff.replace(/-/g, '')}`],
  )
  for (const row of old?.rows ?? []) {
    // DROP, not DELETE. Dropping a partition is a catalogue update; deleting eight million
    // rows is an afternoon of vacuum and a table that never gives the disk back.
    await run(`DROP TABLE IF EXISTS ${row.tablename}`)
    console.info(`[warehouse] dropped partition ${row.tablename} past retention`)
  }
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export interface FeedVersionRow {
  id: number
  loadedAt: string
  agencies: string[]
  trips: number
  stopTimes: number
}

export async function beginFeedVersion(agencies: string[]): Promise<number | null> {
  const r = await run<{ id: number }>(
    'INSERT INTO feed_version (agencies) VALUES ($1) RETURNING id',
    [agencies],
  )
  return r?.rows[0]?.id ?? null
}

export async function saveTrips(feedVersion: number, trips: TripSchedule[]): Promise<number> {
  if (!available() || trips.length === 0) return 0

  const client = await pool!.connect()
  let written = 0
  try {
    await client.query('BEGIN')
    // Batched rather than one statement per trip: forty-eight thousand round trips would
    // take minutes, and this runs while the previous version is still serving.
    const CHUNK = 500
    for (let i = 0; i < trips.length; i += CHUNK) {
      const slice = trips.slice(i, i + CHUNK)
      const values: unknown[] = []
      const rows: string[] = []
      for (const t of slice) {
        const base = values.length
        rows.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},` +
            `$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},` +
            `$${base + 13},$${base + 14},$${base + 15})`,
        )
        values.push(
          feedVersion,
          t.agency,
          t.tripId,
          t.routeId,
          t.directionId,
          t.patternId,
          t.serviceId,
          t.blockId,
          t.shortName,
          t.stops[0]?.departure ?? 0,
          t.stops.map((s) => s.stopId),
          t.stops.map((s) => s.seq),
          t.stops.map((s) => s.arrival),
          t.stops.map((s) => s.departure),
          t.stops.map((s) => s.timepoint),
        )
      }
      await client.query(
        `INSERT INTO scheduled_trip
           (feed_version, agency, trip_id, route_id, direction_id, pattern_id, service_id,
            block_id, short_name, start_s, stop_ids, seqs, arrivals, departures, timepoints)
         VALUES ${rows.join(',')}
         ON CONFLICT (feed_version, trip_id) DO NOTHING`,
        values,
      )
      written += slice.length
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    warehouseStats.failures++
    warehouseStats.lastFailure = (err as Error).message
    console.error('[warehouse] saveTrips failed:', (err as Error).message)
    return 0
  } finally {
    client.release()
  }
  return written
}

export async function saveServiceDays(
  feedVersion: number,
  rows: { agency: string; serviceId: string; day: string }[],
): Promise<number> {
  if (!available() || rows.length === 0) return 0
  const CHUNK = 2000
  let written = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    const values: unknown[] = []
    const tuples: string[] = []
    for (const r of slice) {
      const b = values.length
      tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`)
      values.push(feedVersion, r.agency, r.serviceId, r.day)
    }
    const res = await run(
      `INSERT INTO service_day (feed_version, agency, service_id, day)
       VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`,
      values,
    )
    if (res) written += slice.length
  }
  return written
}

/**
 * Publishes a feed version and retires all but the newest few.
 *
 * Three are kept live, and that is the fix for the quiet failure the old README describes:
 * when a service change ships, the realtime feed moves hours before the archive does, and
 * trips arrive that the newest static tables have never heard of. Resolving a trip against
 * whichever version knows it keeps the pipeline running through the changeover instead of
 * going dark for a day or two, several times a year.
 */
export async function activateFeedVersion(id: number, keep = 3): Promise<void> {
  await run('UPDATE feed_version SET active = true WHERE id = $1', [id])
  await run(
    `DELETE FROM feed_version
      WHERE id NOT IN (SELECT id FROM feed_version ORDER BY id DESC LIMIT $1)`,
    [keep],
  )
}

export async function activeFeedVersions(): Promise<number[]> {
  const r = await run<{ id: number }>(
    'SELECT id FROM feed_version WHERE active ORDER BY id DESC LIMIT 3',
  )
  return (r?.rows ?? []).map((row) => row.id)
}

interface TripRow {
  agency: string
  trip_id: string
  route_id: string
  direction_id: number
  pattern_id: string
  service_id: string
  block_id: string
  short_name: string
  stop_ids: string[]
  seqs: number[]
  arrivals: number[]
  departures: number[]
  timepoints: boolean[]
}

function toTrip(r: TripRow): TripSchedule {
  const stops = r.seqs.map((seq, i) => ({
    stopId: r.stop_ids[i],
    seq,
    arrival: r.arrivals[i],
    departure: r.departures[i],
    timepoint: r.timepoints[i] ?? false,
  }))
  return {
    agency: r.agency,
    tripId: r.trip_id,
    routeId: r.route_id,
    directionId: r.direction_id,
    patternId: r.pattern_id,
    serviceId: r.service_id,
    blockId: r.block_id,
    shortName: r.short_name,
    stops,
    // Derived rather than stored: it is a function of the stops on the row, and a stored
    // copy is one more thing that can disagree with them.
    timepointsInformative: timepointsAreInformative(stops),
  }
}

/**
 * Every trip running on the given service dates, newest feed version winning.
 *
 * Loaded once per service day, not per request. Six thousand trips across five agencies is
 * a few megabytes in memory and every lookup afterwards is a `Map.get`.
 */
export async function loadTripsFor(
  agencies: string[],
  days: ServiceDate[],
): Promise<TripSchedule[]> {
  if (!available() || agencies.length === 0 || days.length === 0) return []

  const r = await run<TripRow>(
    `SELECT DISTINCT ON (t.trip_id)
            t.agency, t.trip_id, t.route_id, t.direction_id, t.pattern_id, t.service_id,
            t.block_id, t.short_name, t.stop_ids, t.seqs, t.arrivals, t.departures, t.timepoints
       FROM scheduled_trip t
       JOIN service_day d
         ON d.feed_version = t.feed_version AND d.service_id = t.service_id
      WHERE t.agency = ANY($1) AND d.day = ANY($2::date[])
        AND t.feed_version IN (SELECT id FROM feed_version WHERE active)
      ORDER BY t.trip_id, t.feed_version DESC`,
    [agencies, days],
  )
  return (r?.rows ?? []).map(toTrip)
}

/**
 * Whether a service date looks unlike that weekday usually does.
 *
 * A holiday changes which service ids run, and GTFS records that in `calendar_dates.txt`
 * without ever using the word. Comparing today's active service ids against the same
 * weekday's recent ones detects it without a hand-maintained list of dates — which would
 * be wrong every year anyway, and would miss the local ones that matter most here.
 */
export async function isHoliday(agency: string, day: ServiceDate): Promise<boolean> {
  if (!available()) return false
  const comparisons = [shiftDate(day, -7), shiftDate(day, -14), shiftDate(day, -21)]
  const r = await run<{ day: string; ids: string[] }>(
    `SELECT day::text AS day, array_agg(service_id ORDER BY service_id) AS ids
       FROM service_day
      WHERE agency = $1 AND day = ANY($2::date[])
        AND feed_version IN (SELECT id FROM feed_version WHERE active)
      GROUP BY day`,
    [agency, [day, ...comparisons]],
  )
  const rows = r?.rows ?? []
  const today = rows.find((x) => x.day === day)
  const others = rows.filter((x) => x.day !== day)
  if (!today || others.length === 0) return false
  const key = today.ids.join(',')
  // Unlike *every* recent instance of this weekday, not merely unlike one of them: a
  // single comparison day that was itself a holiday would otherwise flip the answer.
  return others.every((o) => o.ids.join(',') !== key)
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export interface TripObservationRow {
  serviceDate: string
  agency: string
  tripId: string
  routeId: string
  directionId: number
  patternId: string
  blockId: string
  vehicleId: string
  seqs: number[]
  stopIds: string[]
  schedDep: number[]
  actDep: number[]
  actArr: number[]
  devDep: number[]
  delta: number[]
  tiers: number[]
  held: boolean[]
  predErr: number[]
  anomalous: boolean
}

/** Sentinel for an array slot that has no value. Not zero, which is a real measurement. */
export const ABSENT = -2_147_483_648

export async function writeTripObservations(rows: TripObservationRow[]): Promise<number> {
  if (!available() || rows.length === 0) return 0

  const CHUNK = 200
  let written = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    const values: unknown[] = []
    const tuples: string[] = []
    for (const r of slice) {
      const b = values.length
      tuples.push(
        `(${Array.from({ length: 19 }, (_, j) => `$${b + j + 1}`).join(',')})`,
      )
      values.push(
        r.serviceDate, r.agency, r.tripId, r.routeId, r.directionId, r.patternId,
        r.blockId, r.vehicleId, r.seqs, r.stopIds, r.schedDep, r.actDep, r.actArr,
        r.devDep, r.delta, r.tiers, r.held, r.predErr, r.anomalous,
      )
    }
    const res = await run(
      `INSERT INTO trip_observation
         (service_date, agency, trip_id, route_id, direction_id, pattern_id, block_id,
          vehicle_id, seqs, stop_ids, sched_dep, act_dep, act_arr, dev_dep, delta, tiers,
          held, pred_err, anomalous)
       VALUES ${tuples.join(',')}
       ON CONFLICT (service_date, trip_id) DO UPDATE SET
         seqs = EXCLUDED.seqs, stop_ids = EXCLUDED.stop_ids, sched_dep = EXCLUDED.sched_dep,
         act_dep = EXCLUDED.act_dep, act_arr = EXCLUDED.act_arr, dev_dep = EXCLUDED.dev_dep,
         delta = EXCLUDED.delta, tiers = EXCLUDED.tiers, held = EXCLUDED.held,
         pred_err = EXCLUDED.pred_err, anomalous = EXCLUDED.anomalous, written_at = now()`,
      values,
    )
    if (res) {
      written += slice.length
      warehouseStats.tripsWritten += slice.length
    }
  }
  return written
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface ProfileRow {
  agency: string
  routeId: string
  directionId: number
  segmentKey: string
  dayType: number
  bucket: number
  n: number
  mean: number
  m2: number
  regW: number
  regSx: number
  regSy: number
  regSxx: number
  regSxy: number
  scheduledRun: number
  noiseVar: number
  histogram?: number[] | null
}

/**
 * Writes the profile back.
 *
 * A whole replace rather than an increment: the learner holds the authoritative in-memory
 * copy and this is a checkpoint of it. Incrementing in SQL would make two learners racing
 * each other double-count, and the resulting inflation of `n` has no symptom at all — it
 * simply makes every cell shrink less than it should, everywhere, quietly.
 */
export async function saveProfiles(rows: ProfileRow[]): Promise<number> {
  if (!available() || rows.length === 0) return 0

  const CHUNK = 500
  let written = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    const values: unknown[] = []
    const tuples: string[] = []
    for (const r of slice) {
      const b = values.length
      tuples.push(`(${Array.from({ length: 17 }, (_, j) => `$${b + j + 1}`).join(',')})`)
      values.push(
        r.agency, r.routeId, r.directionId, r.segmentKey, r.dayType, r.bucket,
        r.n, r.mean, r.m2, r.regW, r.regSx, r.regSy, r.regSxx, r.regSxy,
        r.scheduledRun, r.noiseVar, r.histogram ?? null,
      )
    }
    const res = await run(
      `INSERT INTO segment_profile
         (agency, route_id, direction_id, segment_key, day_type, bucket,
          n, mean, m2, reg_w, reg_sx, reg_sy, reg_sxx, reg_sxy,
          scheduled_run, noise_var, histogram)
       VALUES ${tuples.join(',')}
       ON CONFLICT (agency, route_id, direction_id, segment_key, day_type, bucket)
       DO UPDATE SET n = EXCLUDED.n, mean = EXCLUDED.mean, m2 = EXCLUDED.m2,
         reg_w = EXCLUDED.reg_w, reg_sx = EXCLUDED.reg_sx, reg_sy = EXCLUDED.reg_sy,
         reg_sxx = EXCLUDED.reg_sxx, reg_sxy = EXCLUDED.reg_sxy,
         scheduled_run = EXCLUDED.scheduled_run, noise_var = EXCLUDED.noise_var,
         histogram = COALESCE(EXCLUDED.histogram, segment_profile.histogram),
         updated_at = now()`,
      values,
    )
    if (res) {
      written += slice.length
      warehouseStats.profilesWritten += slice.length
    }
  }
  return written
}

/**
 * Reads back exactly the cells a batch of observations is about to touch.
 *
 * The learner is deliberately stateless between ticks. Holding the whole profile in memory
 * would be a few million cells and most of a gigabyte; a five-minute window touches on the
 * order of a couple of thousand, so reading those, updating them and writing them back is
 * bounded work whatever the profile grows into.
 *
 * Safe only because exactly one learner runs at a time, elected by the same Redis lease the
 * poller uses. Two learners doing read-modify-write would double-count silently — and the
 * only symptom would be every cell shrinking less than it should, everywhere, forever.
 */
export async function loadProfileCells(
  keys: { agency: string; routeId: string; directionId: number; segmentKey: string; dayType: number; bucket: number }[],
): Promise<Map<string, ProfileRow>> {
  const out = new Map<string, ProfileRow>()
  if (!available() || keys.length === 0) return out

  const CHUNK = 400
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK)
    const values: unknown[] = []
    const tuples: string[] = []
    for (const k of slice) {
      const b = values.length
      tuples.push(`($${b + 1},$${b + 2},$${b + 3}::smallint,$${b + 4},$${b + 5}::smallint,$${b + 6}::smallint)`)
      values.push(k.agency, k.routeId, k.directionId, k.segmentKey, k.dayType, k.bucket)
    }
    const r = await run<Record<string, never>>(
      `SELECT agency, route_id, direction_id, segment_key, day_type, bucket,
              n, mean, m2, reg_w, reg_sx, reg_sy, reg_sxx, reg_sxy,
              scheduled_run, noise_var, histogram
         FROM segment_profile
        WHERE (agency, route_id, direction_id, segment_key, day_type, bucket)
              IN (${tuples.join(',')})`,
      values,
    )
    for (const row of (r?.rows ?? []) as unknown as Record<string, unknown>[]) {
      const parsed = parseProfileRow(row)
      out.set(profileCellKey(parsed), parsed)
    }
  }
  return out
}

export function profileCellKey(r: {
  agency: string
  routeId: string
  directionId: number
  segmentKey: string
  dayType: number
  bucket: number
}): string {
  return `${r.agency}|${r.routeId}|${r.directionId}|${r.segmentKey}|${r.dayType}|${r.bucket}`
}

function parseProfileRow(row: Record<string, unknown>): ProfileRow {
  return {
    agency: row.agency as string,
    routeId: row.route_id as string,
    directionId: row.direction_id as number,
    segmentKey: row.segment_key as string,
    dayType: row.day_type as number,
    bucket: row.bucket as number,
    n: Number(row.n),
    mean: Number(row.mean),
    m2: Number(row.m2),
    regW: Number(row.reg_w),
    regSx: Number(row.reg_sx),
    regSy: Number(row.reg_sy),
    regSxx: Number(row.reg_sxx),
    regSxy: Number(row.reg_sxy),
    scheduledRun: Number(row.scheduled_run),
    noiseVar: Number(row.noise_var),
    histogram: (row.histogram as number[] | null) ?? null,
  }
}

/** Every cell for one route and day type, which is what building a hot blob needs. */
export async function loadRouteCells(
  agency: string,
  routeId: string,
  directionId: number,
  dayType: number,
): Promise<ProfileRow[]> {
  if (!available()) return []
  const r = await run<Record<string, never>>(
    `SELECT agency, route_id, direction_id, segment_key, day_type, bucket,
            n, mean, m2, reg_w, reg_sx, reg_sy, reg_sxx, reg_sxy,
            scheduled_run, noise_var, NULL::real[] AS histogram
       FROM segment_profile
      WHERE agency = $1 AND route_id = $2 AND direction_id = $3 AND day_type = $4`,
    [agency, routeId, directionId, dayType],
  )
  return ((r?.rows ?? []) as unknown as Record<string, unknown>[]).map(parseProfileRow)
}

export async function loadProfiles(agencies: string[]): Promise<ProfileRow[]> {
  if (!available()) return []
  const r = await run<Record<string, never>>(
    `SELECT agency, route_id, direction_id, segment_key, day_type, bucket,
            n, mean, m2, reg_w, reg_sx, reg_sy, reg_sxx, reg_sxy,
            scheduled_run, noise_var, histogram
       FROM segment_profile WHERE agency = ANY($1)`,
    [agencies],
  )
  return ((r?.rows ?? []) as unknown as Record<string, unknown>[]).map(parseProfileRow)
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface SegmentSummary {
  segmentKey: string
  dayType: number
  bucket: number
  n: number
  mean: number
  sd: number
  slope: number
  scheduledRun: number
}

/** One route's learned behaviour, for the analysis pages. */
export async function routeProfile(
  agency: string,
  routeId: string,
  directionId: number,
  dayType: number,
): Promise<SegmentSummary[]> {
  if (!available()) return []
  const r = await run<Record<string, never>>(
    `SELECT segment_key, day_type, bucket, n, mean, m2, scheduled_run,
            reg_w, reg_sx, reg_sy, reg_sxx, reg_sxy
       FROM segment_profile
      WHERE agency = $1 AND route_id = $2 AND direction_id = $3 AND day_type = $4
      ORDER BY segment_key, bucket`,
    [agency, routeId, directionId, dayType],
  )
  return (r?.rows ?? []).map((row: Record<string, unknown>) => {
    const n = Number(row.n)
    const w = Number(row.reg_w)
    const sx = Number(row.reg_sx)
    const sy = Number(row.reg_sy)
    const sxx = Number(row.reg_sxx)
    const sxy = Number(row.reg_sxy)
    const denom = w > 1 ? sxx - (sx * sx) / w : 0
    return {
      segmentKey: row.segment_key as string,
      dayType: row.day_type as number,
      bucket: row.bucket as number,
      n,
      mean: Number(row.mean),
      sd: n > 0 ? Math.sqrt(Math.max(0, Number(row.m2) / n)) : 0,
      slope: denom > 1e-6 ? (sxy - (sx * sy) / w) / denom : 0,
      scheduledRun: Number(row.scheduled_run),
    }
  })
}

export async function saveScores(
  rows: {
    day: string
    agency: string
    horizon: number
    n: number
    rawMae: number
    rawMedian: number
    corrMae: number
    corrMedian: number
    bias: number
    coverage: number
    winRate: number
  }[],
): Promise<void> {
  for (const r of rows) {
    await run(
      `INSERT INTO model_score
         (day, agency, horizon, n, raw_mae, raw_median, corr_mae, corr_median, bias, coverage, win_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (day, agency, horizon) DO UPDATE SET
         n = EXCLUDED.n, raw_mae = EXCLUDED.raw_mae, raw_median = EXCLUDED.raw_median,
         corr_mae = EXCLUDED.corr_mae, corr_median = EXCLUDED.corr_median,
         bias = EXCLUDED.bias, coverage = EXCLUDED.coverage, win_rate = EXCLUDED.win_rate`,
      [r.day, r.agency, r.horizon, r.n, r.rawMae, r.rawMedian, r.corrMae, r.corrMedian, r.bias, r.coverage, r.winRate],
    )
  }
}

/** Recent scores, which is what the promotion gate reads. */
export async function recentScores(days = 14): Promise<
  { agency: string; horizon: number; n: number; rawMedian: number; corrMedian: number; coverage: number }[]
> {
  if (!available()) return []
  const r = await run<Record<string, never>>(
    `SELECT agency, horizon, sum(n)::int AS n,
            avg(raw_median) AS raw_median, avg(corr_median) AS corr_median,
            avg(coverage) AS coverage
       FROM model_score
      WHERE day > current_date - $1::int
      GROUP BY agency, horizon`,
    [days],
  )
  return (r?.rows ?? []).map((row: Record<string, unknown>) => ({
    agency: row.agency as string,
    horizon: row.horizon as number,
    n: Number(row.n),
    rawMedian: Number(row.raw_median),
    corrMedian: Number(row.corr_median),
    coverage: Number(row.coverage),
  }))
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface WarehouseStatus {
  configured: boolean
  connected: boolean
  schemaVersion: number
  feedVersions: number
  scheduledTrips: number
  observedDays: number
  profileCells: number
  failures: number
  lastFailure: string | null
}

export async function status(): Promise<WarehouseStatus> {
  const base: WarehouseStatus = {
    configured: configured(),
    connected: available(),
    schemaVersion: warehouseStats.migratedTo,
    feedVersions: 0,
    scheduledTrips: 0,
    observedDays: 0,
    profileCells: 0,
    failures: warehouseStats.failures,
    lastFailure: warehouseStats.lastFailure,
  }
  if (!available()) return base

  const r = await run<Record<string, never>>(
    `SELECT
       (SELECT count(*) FROM feed_version WHERE active) AS feed_versions,
       (SELECT count(*) FROM scheduled_trip
         WHERE feed_version IN (SELECT id FROM feed_version WHERE active)) AS trips,
       (SELECT count(DISTINCT service_date) FROM trip_observation) AS days,
       (SELECT count(*) FROM segment_profile) AS cells`,
  )
  const row = (r?.rows[0] ?? {}) as Record<string, unknown>
  return {
    ...base,
    feedVersions: Number(row.feed_versions ?? 0),
    scheduledTrips: Number(row.trips ?? 0),
    observedDays: Number(row.days ?? 0),
    profileCells: Number(row.cells ?? 0),
  }
}

/** Today, in the agency's zone. Convenience so callers do not each reimplement it. */
export function today(): ServiceDate {
  return localDate(Date.now())
}

// ---------------------------------------------------------------------------
// Generic moment tables
// ---------------------------------------------------------------------------

/**
 * The pooled ladder rungs, which are all the same shape.
 *
 * Corridor, route, agency, trip-start and prediction-error profiles differ only in what
 * identifies a cell; every one of them accumulates a decayed count, mean and sum of squares
 * and nothing else. One read-modify-write path for all of them beats five near-identical
 * ones that drift apart.
 *
 * The table and column names come from this whitelist and never from a caller, because the
 * only safe way to interpolate an identifier into SQL is not to.
 */
const MOMENT_TABLES: Record<string, string[]> = {
  corridor_profile: ['agency', 'corridor_key', 'day_type', 'bucket'],
  route_profile: ['agency', 'route_id', 'direction_id', 'day_type', 'bucket'],
  agency_profile: ['agency', 'day_type', 'bucket'],
  start_profile: ['agency', 'route_id', 'direction_id', 'day_type', 'bucket'],
  prediction_error: ['agency', 'route_id', 'direction_id', 'horizon', 'day_type', 'bucket'],
}

export interface MomentRow {
  keys: (string | number)[]
  n: number
  mean: number
  m2: number
}

export function momentKey(table: string, keys: (string | number)[]): string {
  return `${table} ${keys.join(' ')}`
}

export async function loadMoments(
  table: string,
  keys: (string | number)[][],
): Promise<Map<string, MomentRow>> {
  const out = new Map<string, MomentRow>()
  const cols = MOMENT_TABLES[table]
  if (!available() || !cols || keys.length === 0) return out

  const CHUNK = 400
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK)
    const values: unknown[] = []
    const tuples: string[] = []
    for (const k of slice) {
      const b = values.length
      tuples.push(`(${k.map((_, j) => `$${b + j + 1}`).join(',')})`)
      values.push(...k)
    }
    const r = await run<Record<string, never>>(
      `SELECT ${cols.join(',')}, n, mean, m2 FROM ${table}
        WHERE (${cols.join(',')}) IN (${tuples.join(',')})`,
      values,
    )
    for (const row of (r?.rows ?? []) as unknown as Record<string, unknown>[]) {
      const k = cols.map((c) => row[c] as string | number)
      out.set(momentKey(table, k), {
        keys: k,
        n: Number(row.n),
        mean: Number(row.mean),
        m2: Number(row.m2),
      })
    }
  }
  return out
}

export async function saveMoments(table: string, rows: MomentRow[]): Promise<number> {
  const cols = MOMENT_TABLES[table]
  if (!available() || !cols || rows.length === 0) return 0

  const CHUNK = 500
  let written = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    const values: unknown[] = []
    const tuples: string[] = []
    for (const r of slice) {
      const b = values.length
      const all = [...r.keys, r.n, r.mean, r.m2]
      tuples.push(`(${all.map((_, j) => `$${b + j + 1}`).join(',')})`)
      values.push(...all)
    }
    const res = await run(
      `INSERT INTO ${table} (${cols.join(',')}, n, mean, m2)
       VALUES ${tuples.join(',')}
       ON CONFLICT (${cols.join(',')}) DO UPDATE SET
         n = EXCLUDED.n, mean = EXCLUDED.mean, m2 = EXCLUDED.m2, updated_at = now()`,
      values,
    )
    if (res) written += slice.length
  }
  return written
}

/** Every distinct route and direction with a profile, for the publish pass. */
export async function profiledRoutes(): Promise<
  { agency: string; routeId: string; directionId: number; dayType: number }[]
> {
  if (!available()) return []
  const r = await run<Record<string, never>>(
    `SELECT DISTINCT agency, route_id, direction_id, day_type
       FROM segment_profile WHERE bucket >= -1`,
  )
  return ((r?.rows ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
    agency: row.agency as string,
    routeId: row.route_id as string,
    directionId: row.direction_id as number,
    dayType: row.day_type as number,
  }))
}
