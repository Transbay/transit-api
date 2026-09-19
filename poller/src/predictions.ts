import { redis } from './redis.js'
import { anchorFor } from './anchors.js'
import { config } from './config.js'
import * as store from './profilestore.js'
import * as scheduleIndex from './scheduleindex.js'
import { readBlockState } from './learner.js'
import { predict, type Prediction } from './predict.js'
import * as agencyerror from './agencyerror.js'
import { periodOf } from './drift.js'
import {
  Level,
  estimate,
  fromPacked,
  noEstimate,
  LEVEL_NAMES,
  type Estimate,
  type PackedSegment,
} from './profile.js'
import { corridorKey, type TripSchedule } from './schedule.js'
import { DAY_TYPE_NAMES, epochSecondsFor, type DayType } from './servicedate.js'
import type { TripUpdateRecord } from './observe.js'

/**
 * The corrected feed, on its own endpoint.
 *
 * `/v1/departures` is not touched by any of this. It serves the agency's raw times in the
 * SIRI envelope the app has always read, byte-compatible with builds that have been on
 * people's phones for months, and nothing in this file can change that. Corrections live
 * here, where a reader who wants them can ask and a widget that does not is unaffected --
 * unless `DEPARTURES_CORRECTED` is turned on, which applies the confident ones there too
 * (`correction.ts`), in the same envelope.
 *
 * The index below exists for the same reason. Adding a trip reference to the departures
 * snapshot would have been simpler, and would have changed the bytes of the one response
 * that must not change — so the profiled agencies get a second, parallel index carrying
 * exactly what a prediction needs.
 */

const INDEX_PREFIX = 'pred:'

/** One upcoming departure as the agency published it, with enough identity to correct it. */
export interface RawDeparture {
  tripId: string
  routeId: string
  directionId: number
  seq: number
  /** Epoch seconds, exactly as the agency said. */
  raw: number
  vehicleId?: string
}

/** How long the index stays readable after its last write. */
function indexTtl(): number {
  return Math.max(config.poll.intervalSeconds * 6, 900)
}

/**
 * Rewrites one agency's prediction index.
 *
 * Same staging-and-rename discipline the departures snapshot uses, so a reader sees the
 * previous complete index or the new one and never a half-written hash.
 */
export async function writeIndex(agency: string, updates: TripUpdateRecord[]): Promise<number> {
  const byStop = new Map<string, RawDeparture[]>()

  for (const u of updates) {
    if (u.relationship === 'CANCELED') continue
    for (const stu of u.stops) {
      const raw = stu.departure ?? stu.arrival
      if (raw === undefined || stu.relationship === 'SKIPPED') continue
      const seq = stu.seq ?? scheduleIndex.current().seqOf(u.tripId, stu.stopId)
      if (seq < 0) continue

      const entry: RawDeparture = {
        tripId: u.tripId,
        routeId: u.routeId,
        directionId: u.directionId ?? 0,
        seq,
        raw,
        vehicleId: u.vehicleId,
      }
      const list = byStop.get(stu.stopId)
      if (list) list.push(entry)
      else byStop.set(stu.stopId, [entry])
    }
  }

  if (byStop.size === 0) return 0

  const key = `${INDEX_PREFIX}${agency}`
  const staging = `${key}:staging`
  try {
    await redis.del(staging)
    const entries: string[] = []
    for (const [stopId, list] of byStop) {
      list.sort((a, b) => a.raw - b.raw)
      entries.push(stopId, JSON.stringify(list))
    }
    const CHUNK = 500
    for (let i = 0; i < entries.length; i += CHUNK * 2) {
      await redis.hset(staging, ...entries.slice(i, i + CHUNK * 2))
    }
    await redis.pipeline().rename(staging, key).expire(key, indexTtl()).exec()
  } catch (err) {
    console.error(`[predictions] index write failed for ${agency}:`, (err as Error).message)
    return 0
  }
  return byStop.size
}

/**
 * Whether an agency's index is there at all. Distinguishes "this trip has left the stop"
 * from "the feed has gone quiet", which an empty `readIndex` cannot.
 */
export async function indexExists(agency: string): Promise<boolean> {
  try {
    return (await redis.exists(`${INDEX_PREFIX}${agency}`)) === 1
  } catch {
    return false
  }
}

export async function readIndex(agency: string, stopId: string): Promise<RawDeparture[]> {
  try {
    const raw = await redis.hget(`${INDEX_PREFIX}${agency}`, stopId)
    return raw ? (JSON.parse(raw) as RawDeparture[]) : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

export interface PredictionEntry {
  tripId: string
  lineRef: string
  destination: string
  stopId: string
  /** Exactly what the agency said. Always present. */
  raw: string
  /** What we think. Equal to `raw` whenever we decline to correct. */
  predicted: string
  correctionSeconds: number
  p10: string
  p50: string
  p90: string
  confidence: string
  basis: Prediction['basis']
  evidence: {
    samples: number
    level: string
    dayType: string
    bucket: number
    estimators: Prediction['estimators']
    clamps: string[]
    disagreementSeconds: number
    /** Whether the walk started from where the vehicle was last seen. */
    anchored?: boolean
  }
}

export interface PredictionResponse {
  agency: string
  stopCode: string
  generatedAt: string
  mode: string
  /** True when this agency has no profile yet, so every entry is the raw value. */
  cold: boolean
  predictions: PredictionEntry[]
}

/** The ladder's "every day together" rung, stored beside the real day types. */
const POOLED_DAY_TYPE = -1 as unknown as DayType

function iso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Builds the ladder input for one segment from the packed hot profile.
 *
 * The corridor and route rungs are not in the blob — they are pooled across routes, and
 * duplicating them into every route's blob would multiply the storage by however many
 * routes share a corridor. A segment with nothing of its own falls back to its own all-time
 * rung and then to the agency default, which is the honest answer: `fallback: true` and a
 * confidence of `none`.
 */
function ladderFor(
  segments: Map<string, PackedSegment>,
  pooled: Map<string, PackedSegment>,
  trip: TripSchedule,
  index: number,
  bucket: number,
  now: number,
): Estimate {
  const from = trip.stops[index - 1]
  const to = trip.stops[index]
  if (!from || !to) {
    return noEstimate()
  }

  const key = corridorKey({ fromStopId: from.stopId, toStopId: to.stopId, occurrence: 0 })

  const specific = segments.get(key)
  const best = specific ? estimate(fromPacked(specific, bucket, now)) : noEstimate()
  if (best.n > 0) return best

  // Fall back to the pooled all-days rung.
  //
  // The ladder is supposed to walk coarse-to-fine, but the hot path loads exactly one
  // day type's blob and so could not walk anything: on a day whose own cells are empty --
  // a public holiday, or any day type first seen hours ago -- every segment returned no
  // estimate and every prediction degenerated to the timetable. Meanwhile the pooled rung
  // for the same segment held ten observations and was never asked.
  const fallback = pooled.get(key)
  if (!fallback) return best
  return estimate(fromPacked(fallback, bucket, now))
}

/**
 * Corrected predictions for one stop.
 *
 * Every entry carries what the agency said alongside what we think and why. A correction of
 * seventeen minutes is only worth anything if the reader can see where it came from and how
 * many observations stand behind it — an unexplained number that large is indistinguishable
 * from a bug, and should be treated as one until it explains itself.
 */
export async function predictionsFor(
  agency: string,
  stopCode: string,
  now = Math.floor(Date.now() / 1000),
): Promise<PredictionResponse> {
  const entries = await readIndex(agency, stopCode)
  const index = scheduleIndex.current()
  const mode = config.predictions.mode

  const out: PredictionEntry[] = []
  let cold = true

  for (const entry of entries.slice(0, 12)) {
    const trip = index.trip(entry.tripId)
    if (!trip) {
      out.push(rawOnly(entry, stopCode, now))
      continue
    }

    const target = index.positionOf(entry.tripId, stopCode, entry.seq)
    if (target < 0) {
      out.push(rawOnly(entry, stopCode, now))
      continue
    }

    const serviceDate = scheduleIndex.status().loadedFor ?? ''
    const dayType = scheduleIndex.dayTypeFor(agency, serviceDate)
    const segments = await store.load(agency, trip.routeId, trip.directionId, dayType)
    // `-1` is the pooled rung: every day together. Loaded alongside rather than instead,
    // so a day type with its own evidence still wins.
    const pooled = await store.load(agency, trip.routeId, trip.directionId, POOLED_DAY_TYPE)
    if (segments.size > 0 || pooled.size > 0) cold = false

    const bucket = Math.floor(trip.stops[target].departure / 1800) % 60
    const block = await readBlockState(agency, serviceDate, entry.vehicleId, trip.blockId)

    // Where this vehicle was last seen leaving a stop, if that stop is before this one.
    // Without it the walk starts at the trip's origin on the timetable, blind to where the
    // bus is and to how its driver is running today.
    const seen = anchorFor(entry.tripId, now)
    const anchorIndex = seen ? index.positionOf(entry.tripId, seen.stopId, seen.seq) : -1
    const anchor =
      seen && anchorIndex >= 0 && anchorIndex < target
        ? { index: anchorIndex, deviation: seen.deviation, at: seen.at }
        : undefined

    const prediction =
      mode === 'off'
        ? null
        : predict({
            trip,
            serviceDate,
            now,
            target,
            agencyPrediction: entry.raw,
            anchor,
            // How this producer's own estimate typically moves between now and arrival.
            // Undefined where it has not been measured, which leaves the agency estimator
            // on its pessimistic default variance — in the fusion, but unable to dominate
            // it. Where it has been measured, this is what anticipates the late jump
            // instead of waiting to observe it.
            agencyError: agencyerror.lookup(
              agency,
              trip.routeId,
              trip.directionId,
              entry.raw - now,
              dayType,
              periodOf(trip.stops[target].departure),
            ),
            profileFor: (i) => ladderFor(segments, pooled, trip, i, bucket, now),
            block,
            minSamples: config.predictions.minSamples,
            holdOffset: config.profile.holdOffsetSeconds,
          })

    if (!prediction) {
      out.push(rawOnly(entry, stopCode, now))
      continue
    }

    // In shadow mode the correction is computed, logged and scored, and the reported number
    // is the agency's own. The gate is about what we are willing to *claim*, not about
    // whether the work happens: a model nobody can compare against raw is a model nobody
    // can ever promote.
    const claim = mode === 'on' && prediction.confidence !== 'none'
    const shown = claim ? prediction.time : entry.raw

    out.push({
      tripId: entry.tripId,
      lineRef: trip.routeId.includes(':') ? trip.routeId.split(':')[1] : trip.routeId,
      destination: '',
      stopId: stopCode,
      raw: iso(entry.raw),
      predicted: iso(shown),
      correctionSeconds: shown - entry.raw,
      p10: iso(prediction.low),
      p50: iso(prediction.time),
      p90: iso(prediction.high),
      confidence: claim ? prediction.confidence : mode === 'shadow' ? 'shadow' : 'none',
      basis: prediction.basis,
      evidence: {
        samples: prediction.n,
        level: LEVEL_NAMES[prediction.level] ?? 'unknown',
        dayType: DAY_TYPE_NAMES[dayType] ?? 'unknown',
        bucket,
        estimators: prediction.estimators,
        clamps: prediction.clamps,
        disagreementSeconds: prediction.disagreementSeconds,
        anchored: anchor !== undefined,
      },
    })
  }

  return {
    agency,
    stopCode,
    generatedAt: iso(now),
    mode,
    cold,
    predictions: out,
  }
}

/** What we return when there is nothing to correct with: the agency's number, said plainly. */
function rawOnly(entry: RawDeparture, stopId: string, now: number): PredictionEntry {
  return {
    tripId: entry.tripId,
    lineRef: entry.routeId.includes(':') ? entry.routeId.split(':')[1] : entry.routeId,
    destination: '',
    stopId,
    raw: iso(entry.raw),
    predicted: iso(entry.raw),
    correctionSeconds: 0,
    p10: iso(entry.raw),
    p50: iso(entry.raw),
    p90: iso(entry.raw),
    confidence: 'none',
    basis: { schedule: 0, profile: 0, block: 0, hold: 0, agencyError: 0 },
    evidence: {
      samples: 0,
      level: 'none',
      dayType: 'unknown',
      bucket: -1,
      estimators: [],
      clamps: ['no-schedule'],
      disagreementSeconds: 0,
    },
  }
}

export async function indexStatus(): Promise<{ agency: string; stops: number }[]> {
  const out: { agency: string; stops: number }[] = []
  for (const agency of config.profile.agencies) {
    try {
      out.push({ agency, stops: await redis.hlen(`${INDEX_PREFIX}${agency}`) })
    } catch {
      out.push({ agency, stops: -1 })
    }
  }
  return out
}
