import { redis } from './redis.js'
import { config } from './config.js'
import { envelope, type GroupedAgency, type MonitoredStopVisit, type SIRIResponse } from './siri.js'

/** The live picture of every agency, indexed by stop. */

function hashKey(agency: string): string {
  return `511:snap:${agency}`
}

function stampKey(agency: string): string {
  return `511:snap:${agency}:at`
}

/** A staging key, swapped into place atomically once fully written. */
function stagingKey(agency: string): string {
  return `511:snap:${agency}:staging`
}

/** How long a snapshot remains readable after its last successful write. */
function snapshotTtl(): number {
  return Math.max(config.poll.intervalSeconds * 6, 900)
}

/**
 * Redis caps how many field/value pairs one HSET can carry comfortably. Muni alone
 * returns thousands of stops, so the write is chunked rather than sent as one
 * enormous command.
 */
const HSET_CHUNK = 500

/** Replaces one agency's snapshot. */
export async function writeSnapshot(agency: string, grouped: GroupedAgency): Promise<number> {
  const staging = stagingKey(agency)
  const ttl = snapshotTtl()

  // A staging key left behind by a crashed write would merge into this one.
  await redis.del(staging)

  const entries: string[] = []
  for (const [stopCode, visits] of grouped.byStop) {
    entries.push(stopCode, JSON.stringify(visits))
  }

  if (entries.length === 0) {
    // An empty response is not a reason to throw away a good snapshot — 511 returns
    // one for an agency that has stopped running for the night.
    return 0
  }

  for (let i = 0; i < entries.length; i += HSET_CHUNK * 2) {
    await redis.hset(staging, ...entries.slice(i, i + HSET_CHUNK * 2))
  }

  await redis
    .pipeline()
    .rename(staging, hashKey(agency))
    .expire(hashKey(agency), ttl)
    .set(stampKey(agency), grouped.responseTimestamp ?? new Date().toISOString(), 'EX', ttl)
    .exec()

  return grouped.byStop.size
}

export interface SnapshotRead {
  response: SIRIResponse
  /** Seconds since the snapshot this came from was written. */
  ageSeconds: number
  /** False when the agency is known but this particular stop had no visits. */
  hadVisits: boolean
}

/** Reads one stop out of the snapshot. */
export async function readSnapshot(agency: string, stopCode: string): Promise<SnapshotRead | null> {
  // One round trip for both the stop's visits and the snapshot's timestamp.
  const results = await redis
    .pipeline()
    .hget(hashKey(agency), stopCode)
    .get(stampKey(agency))
    .exec()

  for (const entry of results ?? []) {
    if (entry?.[0]) throw entry[0]
  }

  const visitsRaw = (results?.[0]?.[1] ?? null) as string | null
  const stampRaw = (results?.[1]?.[1] ?? null) as string | null

  if (stampRaw == null) return null

  const writtenAt = Date.parse(stampRaw)
  const ageSeconds = Number.isNaN(writtenAt)
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.round((Date.now() - writtenAt) / 1000))

  const visits: MonitoredStopVisit[] = visitsRaw ? (JSON.parse(visitsRaw) as MonitoredStopVisit[]) : []

  return {
    response: envelope(visits, stampRaw),
    ageSeconds,
    hadVisits: visits.length > 0,
  }
}

export interface AgencySnapshotStatus {
  agency: string
  stops: number
  ageSeconds: number | null
}

/**
 * The agencies we have actually written a snapshot for.
 *
 * Kept as a set rather than read from configuration, because the configuration is now
 * usually `*` -- publish whatever the regional feed carries. Discovering the list from the
 * feed means an operator joining 511 appears on its own and one leaving stops being
 * reported as permanently stale.
 */
const AGENCY_SET_KEY = '511:snap:agencies'

export async function rememberAgency(agency: string): Promise<void> {
  try {
    await redis.sadd(AGENCY_SET_KEY, agency)
  } catch {
    // /health loses a row. Nothing a rider can see.
  }
}

export async function knownAgencies(): Promise<string[]> {
  try {
    const stored = await redis.smembers(AGENCY_SET_KEY)
    if (stored.length > 0) return stored.sort()

    // The set is only written by this build, so a Redis shared with an older one -- or a
    // replica that has not led a poll cycle yet -- has snapshots but no set. Recover the
    // list from the keys themselves rather than reporting no agencies at all, which reads
    // as "nothing is being polled" on a service that is merely not the leader.
    const found = new Set<string>()
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', '511:snap:*', 'COUNT', 200)
      cursor = next
      for (const key of keys) {
        const parts = key.split(':')
        // `511:snap:<agency>`, and not `...:at` or `...:staging`.
        if (parts.length === 3 && parts[2]) found.add(parts[2])
      }
    } while (cursor !== '0')
    if (found.size > 0) return [...found].sort()
  } catch {
    // Fall through to the configured list.
  }
  // Empty when POLLED_AGENCIES is `*`, which is honest: we have not been told a list and
  // have not discovered one.
  return config.poll.agencies
}

/** Per-agency snapshot state, for /health. */
export async function snapshotStatus(): Promise<AgencySnapshotStatus[]> {
  const agencies = await knownAgencies()
  const results = await redis
    .pipeline(
      agencies.flatMap((a) => [
        ['hlen', hashKey(a)],
        ['get', stampKey(a)],
      ]) as [string, string][],
    )
    .exec()

  return agencies.map((agency, i) => {
    const stops = Number(results?.[i * 2]?.[1] ?? 0)
    const stamp = results?.[i * 2 + 1]?.[1] as string | null
    const writtenAt = stamp ? Date.parse(stamp) : NaN
    return {
      agency,
      stops,
      ageSeconds: Number.isNaN(writtenAt)
        ? null
        : Math.max(0, Math.round((Date.now() - writtenAt) / 1000)),
    }
  })
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

/** Live vehicle positions, stored whole rather than indexed by stop. */
function vehicleKey(agency: string): string {
  return `511:veh:${agency}`
}

function vehicleStampKey(agency: string): string {
  return `511:veh:${agency}:at`
}

/** Replaces the stored vehicles for every agency present in this cycle. */
/**
 * How long an extrapolated position stays readable.
 *
 * Much shorter than `snapshotTtl()`. A measured position that is 10 minutes old is
 * merely stale; an *inferred* one is fiction, because the inference was only ever valid
 * for the interval it was computed in. Without this, a BART outage would leave a
 * quarter-hour of trains on the map that never existed.
 */
const SYNTHESIZED_TTL_SECONDS = 90

export async function writeVehicles<T extends VehicleLike>(list: T[]): Promise<number> {
  const byAgency = new Map<string, T[]>()
  for (const v of list) {
    const bucket = byAgency.get(v.agency)
    if (bucket) bucket.push(v)
    else byAgency.set(v.agency, [v])
  }

  if (byAgency.size === 0) return 0

  const now = new Date().toISOString()
  const pipeline = redis.pipeline()
  for (const [agency, vehicles] of byAgency) {
    // An agency whose positions are entirely inferred expires quickly; one with real
    // reported positions keeps the generous snapshot TTL.
    const inferred = vehicles.every(
      (v) => (v as { source?: string }).source === 'synthesized',
    )
    const ttl = inferred ? SYNTHESIZED_TTL_SECONDS : snapshotTtl()
    pipeline.set(vehicleKey(agency), JSON.stringify(vehicles), 'EX', ttl)
    pipeline.set(vehicleStampKey(agency), now, 'EX', ttl)
  }
  await pipeline.exec()

  return list.length
}

/** The only field this module needs to understand. */
export interface VehicleLike {
  agency: string
}

export interface VehicleRead {
  vehicles: unknown[]
  ageSeconds: number
}

/** Reads one agency's vehicles. Null when we have never stored any. */
export async function readVehicles(agency: string): Promise<VehicleRead | null> {
  const results = await redis
    .pipeline()
    .get(vehicleKey(agency))
    .get(vehicleStampKey(agency))
    .exec()

  for (const entry of results ?? []) {
    if (entry?.[0]) throw entry[0]
  }

  const raw = (results?.[0]?.[1] ?? null) as string | null
  const stamp = (results?.[1]?.[1] ?? null) as string | null
  if (raw == null || stamp == null) return null

  const writtenAt = Date.parse(stamp)
  return {
    vehicles: JSON.parse(raw) as unknown[],
    ageSeconds: Number.isNaN(writtenAt)
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.round((Date.now() - writtenAt) / 1000)),
  }
}
