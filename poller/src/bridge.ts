import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import { config } from './config.js'
import { redis } from './redis.js'
import type { VehicleRecord } from './gtfsrt.js'

const { transit_realtime: rt } = GtfsRealtimeBindings

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
 * ## Vehicles 511 does not carry
 *
 * BART publishes no positions anywhere, so its trains are synthesised from trip updates
 * (`bartposition.ts`). They cannot go in `hw:vp` without breaking the one rule, so they go
 * in **`hw:vpx:<region>`**: a GTFS-RT `FeedMessage` of our own making, which the consumer
 * appends to the 511 feed after unmarshalling it. A new key rather than a reshaped one, so
 * the contract version does not move and a consumer that has never heard of it is
 * unaffected.
 */

/** How the last publish went, for `/health`. Counters, because nobody watches silence. */
export interface BridgeStats {
  lastPublishAt: string | null
  vehicleBytes: number
  tripUpdateBytes: number
  /** Synthesised vehicles on `hw:vpx` last cycle. Zero overnight; zero all day is BART lost. */
  synthVehicles: number
  corrections: number
  /** Alert on this. A rising count means headways is quietly running on stale bytes. */
  failures: number
  lastError: string | null
}

const stats: BridgeStats = {
  lastPublishAt: null,
  vehicleBytes: 0,
  tripUpdateBytes: 0,
  synthVehicles: 0,
  corrections: 0,
  failures: 0,
  lastError: null,
}

export function bridgeStatus(): BridgeStats & { enabled: boolean; region: string } {
  return { ...stats, enabled: config.bridge.enabled, region: config.bridge.region }
}

const vpKey = () => `hw:vp:${config.bridge.region}`
const vpxKey = () => `hw:vpx:${config.bridge.region}`
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

/**
 * Encodes synthesised vehicles as GTFS-RT, the shape the consumer already unmarshals.
 *
 * The trip id is rebuilt as `<agency>:<id>` because that is how the 511 archive keys its
 * trips, and `bartposition.ts` makes the id by stripping exactly that prefix. With it the
 * consumer's existing static-GTFS join supplies route, shape and headsign unchanged.
 */
export function encodeSynthVehicles(records: VehicleRecord[], at: Date): Uint8Array {
  const feed = rt.FeedMessage.create({
    header: {
      gtfsRealtimeVersion: '2.0',
      incrementality: rt.FeedHeader.Incrementality.FULL_DATASET,
      timestamp: Math.floor(at.getTime() / 1000),
    },
    entity: records.map((r) => {
      const tripId = `${r.agency}:${r.id}`
      return {
        id: tripId,
        vehicle: {
          trip: { tripId },
          vehicle: { id: r.id, label: r.destination },
          position: {
            latitude: r.lat,
            longitude: r.lon,
            ...(r.bearing !== undefined ? { bearing: r.bearing } : {}),
            ...(r.speed !== undefined ? { speed: r.speed } : {}),
          },
          ...(r.nextStopId
            ? { stopId: r.nextStopId, currentStatus: rt.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO }
            : {}),
          timestamp: Math.floor(Date.parse(r.at) / 1000),
        },
      }
    }),
  })
  return rt.FeedMessage.encode(feed).finish()
}

/**
 * Publishes this cycle's synthesised vehicles on `hw:vpx`.
 *
 * Only synthesised records are taken, whatever the caller passes: anything measured is
 * already in `hw:vp`, and a vehicle in both would be drawn twice.
 */
export async function publishSynthVehicles(records: VehicleRecord[], at: Date): Promise<void> {
  if (!config.bridge.enabled || !config.bridge.synthVehicles) return
  const synth = records.filter((r) => r.source === 'synthesized')
  const ttl = config.bridge.ttlSeconds
  await redis
    .pipeline()
    .set(vpxKey(), Buffer.from(encodeSynthVehicles(synth, at)), 'EX', ttl)
    .set(`${vpxKey()}:at`, at.toISOString(), 'EX', ttl)
    .exec()
  stats.synthVehicles = synth.length
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
