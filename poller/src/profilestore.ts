import { config } from './config.js'
import { redis } from './redis.js'
import { packProfile, unpackProfile, type PackedSegment } from './profile.js'
import type { DayType } from './servicedate.js'

/**
 * The hot side of the profile.
 *
 * Everything the prediction path reads lives here, packed, in Redis — never in Postgres.
 * That is not a performance decision so much as an availability one: predictions must keep
 * working while the warehouse is down, being reindexed, or simply absent, and the only way
 * to guarantee that is for the serving path never to have learned how to talk to it.
 *
 * One key per route, direction and day type, holding every segment. The obvious
 * alternative — a hash field per cell — costs around 110 bytes of Redis overhead *per
 * field*, which across a few million populated cells is most of a gigabyte of key metadata
 * to store a few tens of megabytes of numbers. It is also forty round trips to predict one
 * trip, where this is one.
 */

const VERSION_KEY = 'prof:version'

function key(agency: string, routeId: string, directionId: number, dayType: DayType): string {
  return `prof:${agency}:${routeId}:${directionId}:${dayType}`
}

export const profileStoreStats = {
  published: 0,
  publishFailures: 0,
  reads: 0,
  hits: 0,
  bytes: 0,
}

/** Replaces one route-direction-daytype's profile. */
export async function publish(
  agency: string,
  routeId: string,
  directionId: number,
  dayType: DayType,
  segments: PackedSegment[],
): Promise<void> {
  try {
    const blob = packProfile(segments)
    // No TTL. A profile is the durable artefact of months of observation, and an expiring
    // one would silently degrade predictions on any route quiet enough not to be rewritten
    // — which is exactly the set of routes that most need their history.
    await redis.set(key(agency, routeId, directionId, dayType), blob)
    profileStoreStats.published++
    profileStoreStats.bytes += blob.length
  } catch (err) {
    profileStoreStats.publishFailures++
    console.error('[profilestore] publish failed:', (err as Error).message)
  }
}

/** Stamps a new version, which invalidates every reader's in-process cache. */
export async function bumpVersion(): Promise<void> {
  try {
    await redis.set(VERSION_KEY, String(Date.now()))
  } catch {
    // A missed bump means readers keep a slightly stale profile for one interval. The
    // profile changes on the order of days; this is not worth failing anything over.
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface CacheEntry {
  version: string
  segments: Map<string, PackedSegment>
}

/**
 * In-process cache, invalidated by version.
 *
 * The same pattern `loadBartGeometry` uses, for the same reason: this is read on every
 * prediction for every stop on every request, and the underlying bytes change every few
 * minutes at most.
 */
const cache = new Map<string, CacheEntry>()

/**
 * Most-recently-used first out of the door last: a Map iterates in insertion order, so a
 * hit is re-inserted at the end and the oldest key is the first one.
 *
 * Bounded because the whole profile is hundreds of megabytes packed and several times that
 * unpacked (~2 MB per route and day type), and requests wander: without a ceiling, every route anybody ever asked
 * about stayed unpacked in this process until the next deploy.
 */
function remember(k: string, entry: CacheEntry): void {
  cache.delete(k)
  cache.set(k, entry)
  while (cache.size > config.profile.cacheRoutes) {
    cache.delete(cache.keys().next().value!)
  }
}
let cachedVersion = ''
let versionCheckedAt = 0

/** How long to go between asking Redis whether the profile has moved. */
const VERSION_TTL_MS = 30_000

async function currentVersion(): Promise<string> {
  const now = Date.now()
  if (now - versionCheckedAt < VERSION_TTL_MS) return cachedVersion
  versionCheckedAt = now
  try {
    cachedVersion = (await redis.get(VERSION_KEY)) ?? ''
  } catch {
    // Keep whatever we had. A stale profile beats no profile, and the caller cannot tell
    // the difference in a way that matters over thirty seconds.
  }
  return cachedVersion
}

export async function load(
  agency: string,
  routeId: string,
  directionId: number,
  dayType: DayType,
): Promise<Map<string, PackedSegment>> {
  const k = key(agency, routeId, directionId, dayType)
  const version = await currentVersion()

  const hit = cache.get(k)
  if (hit && hit.version === version) {
    profileStoreStats.reads++
    profileStoreStats.hits++
    remember(k, hit)
    return hit.segments
  }

  profileStoreStats.reads++
  try {
    const blob = await redis.getBuffer(k)
    const segments = blob ? unpackProfile(blob) : new Map<string, PackedSegment>()
    remember(k, { version, segments })
    return segments
  } catch (err) {
    console.error('[profilestore] read failed:', (err as Error).message)
    // An empty profile means every prediction falls back to the agency's own number, which
    // is exactly today's behaviour and is always a defensible answer.
    return hit?.segments ?? new Map()
  }
}

/**
 * Every day type for a route, so one request can cover a trip that crosses midnight.
 *
 * A Friday-night owl trip's later stops still belong to Friday's service day, so this is
 * usually one day type — but a caller that needs two should get them in one round trip.
 */
export async function loadMany(
  agency: string,
  routeId: string,
  directionId: number,
  dayTypes: DayType[],
): Promise<Map<DayType, Map<string, PackedSegment>>> {
  const out = new Map<DayType, Map<string, PackedSegment>>()
  await Promise.all(
    dayTypes.map(async (dt) => {
      out.set(dt, await load(agency, routeId, directionId, dt))
    }),
  )
  return out
}

/** Drops the in-process cache. For tests and for a forced reload. */
export function clearCache(): void {
  cache.clear()
  cachedVersion = ''
  versionCheckedAt = 0
}

export async function status(): Promise<{
  routes: number
  bytes: number
  version: string | null
  cached: number
}> {
  try {
    const keys = await redis.keys('prof:*:*:*:*')
    return {
      routes: keys.length,
      bytes: profileStoreStats.bytes,
      version: await redis.get(VERSION_KEY),
      cached: cache.size,
    }
  } catch {
    return { routes: -1, bytes: profileStoreStats.bytes, version: null, cached: cache.size }
  }
}
