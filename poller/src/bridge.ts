import { config } from './config.js'
import { redis } from './redis.js'

/**
 * The bridge to the Go `headways-server`.
 *
 * headways used to poll 511 itself, a minute at a time, on its own key. It now reads what
 * this service already fetched fifteen seconds ago — so the map gets fresher data, the
 * shared key budget stops being spent twice, and there is one place in the world that
 * talks to 511.
 *
 * ## The one rule
 *
 * **`hw:vp` and `hw:tu` are the 511 protobuf, byte for byte.**
 *
 * Not a translation of it, not a filtered copy, not a re-encode. The consumer runs
 * `proto.Unmarshal` on these bytes exactly as it used to run it on the HTTP response, and
 * every field it derives downstream — headsigns, block ids, the vehicle roster join — is
 * therefore unchanged by construction rather than by care. That is what makes the swap
 * verifiable: the same GraphQL response, from the same bytes, by a different route.
 *
 * If a future version needs to reshape them, that is a new key and a `bridge.version`
 * bump. Editing these in place would break a consumer that has no way to notice.
 *
 * ## What is deliberately not here
 *
 * BART. It is synthesised into `511:veh:BA` and fed to the learner, but it is *not* in
 * `hw:vp` — headways has no BART styling and a fleet of grey untitled dots is worse than
 * no dots. `hw:corr` is agency-agnostic and may carry BART entries; the consumer simply
 * has no BART vehicle to attach them to.
 */

/** How the last publish went, for `/health`. Counters, because nobody watches silence. */
export interface BridgeStats {
  lastPublishAt: string | null
  vehicleBytes: number
  tripUpdateBytes: number
  corrections: number
  /** Alert on this. A rising count means headways is quietly running on stale bytes. */
  failures: number
  lastError: string | null
}

const stats: BridgeStats = {
  lastPublishAt: null,
  vehicleBytes: 0,
  tripUpdateBytes: 0,
  corrections: 0,
  failures: 0,
  lastError: null,
}

export function bridgeStatus(): BridgeStats & { enabled: boolean; region: string } {
  return { ...stats, enabled: config.bridge.enabled, region: config.bridge.region }
}

const vpKey = () => `hw:vp:${config.bridge.region}`
const tuKey = () => `hw:tu:${config.bridge.region}`
const corrKey = () => `hw:corr:${config.bridge.region}`

/**
 * Publishes this cycle's raw feeds.
 *
 * Both buffers and their timestamps go in one pipeline, so a consumer polling between the
 * two writes sees the previous pair rather than one new feed beside one old one. It cannot
 * see a torn pair, which matters because the two are joined on trip id downstream.
 *
 * Fire and forget by design: the caller wraps this, and a failure here costs headways
 * freshness, never this service a poll cycle.
 */
export async function publishFeeds(
  vehicles: Uint8Array | null,
  tripUpdates: Uint8Array | null,
  fetchedAt: Date,
): Promise<void> {
  if (!config.bridge.enabled) return
  if (!vehicles && !tripUpdates) return

  const ttl = config.bridge.ttlSeconds
  const at = fetchedAt.toISOString()
  const pipeline = redis.pipeline()

  if (vehicles) {
    pipeline.set(vpKey(), Buffer.from(vehicles), 'EX', ttl)
    pipeline.set(`${vpKey()}:at`, at, 'EX', ttl)
  }
  if (tripUpdates) {
    pipeline.set(tuKey(), Buffer.from(tripUpdates), 'EX', ttl)
    pipeline.set(`${tuKey()}:at`, at, 'EX', ttl)
  }
  // No TTL: a consumer that finds feeds but no version should refuse them, not guess.
  pipeline.set('hw:bridge:v', String(config.bridge.version))

  await pipeline.exec()

  stats.lastPublishAt = at
  stats.vehicleBytes = vehicles?.byteLength ?? 0
  stats.tripUpdateBytes = tripUpdates?.byteLength ?? 0
}

/** One corrected departure, as the Go server reads it. Keys are short because there are many. */
export interface BridgeCorrection {
  /** Corrected departure, epoch seconds. */
  p: number
  /** Band, epoch seconds. */
  lo: number
  hi: number
  /** `low` | `medium` | `high`. */
  c: string
  /** Correction applied, seconds. Negative is earlier than the agency said. */
  d: number
}

const RANK: Record<string, number> = { none: 0, shadow: 0, low: 1, medium: 2, high: 3 }

/** Whether a correction is confident enough to be allowed to move a displayed time. */
export function meetsThreshold(confidence: string): boolean {
  const floor = RANK[config.bridge.minConfidence] ?? 2
  return (RANK[confidence] ?? 0) >= floor
}

/**
 * Publishes corrected departure times, keyed by trip and stop.
 *
 * Field key is `tripId\x1fstopId` — the unit separator, matching how `gtfs.ts` already
 * packs compound keys, and safe because neither id may contain it.
 *
 * Entries below the confidence floor are dropped rather than published with a flag. A
 * consumer that has to decide what to trust will eventually get it wrong; the floor
 * belongs in one place, and this is it.
 */
export async function publishCorrections(
  entries: Iterable<{ tripId: string; stopId: string; correction: BridgeCorrection }>,
): Promise<number> {
  if (!config.bridge.enabled || !config.bridge.corrections) return 0

  const flat: string[] = []
  let count = 0
  for (const { tripId, stopId, correction } of entries) {
    if (!meetsThreshold(correction.c)) continue
    flat.push(`${tripId}\x1f${stopId}`, JSON.stringify(correction))
    count++
  }

  const staging = `${corrKey()}:staging`
  if (count === 0) {
    // An empty result is a real answer — nothing was confident enough this cycle — and
    // must clear the previous one rather than leave it to be read as current.
    await redis.del(corrKey())
    stats.corrections = 0
    return 0
  }

  // Stage then rename, the same pattern `writeSnapshot` and `writeIndex` use, so a reader
  // never observes a half-written hash.
  const pipeline = redis.pipeline()
  pipeline.del(staging)
  for (let i = 0; i < flat.length; i += 2000) {
    pipeline.hset(staging, ...flat.slice(i, i + 2000))
  }
  pipeline.expire(staging, config.bridge.ttlSeconds)
  pipeline.rename(staging, corrKey())
  pipeline.expire(corrKey(), config.bridge.ttlSeconds)
  await pipeline.exec()

  stats.corrections = count
  return count
}

/** Records a bridge failure without letting it escape into the poll cycle. */
export function reportBridgeFailure(what: string, err: unknown): void {
  stats.failures++
  stats.lastError = `${what}: ${(err as Error)?.message ?? String(err)}`
  console.error(`[bridge] ${stats.lastError}`)
}
