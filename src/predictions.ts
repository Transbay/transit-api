import { redis } from './redis.js'
import { config } from './config.js'
import * as store from './profilestore.js'
import * as scheduleIndex from './scheduleindex.js'
import { readBlockState } from './learner.js'
import { predict, type Prediction } from './predict.js'
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
import { DAY_TYPE_NAMES, epochSecondsFor } from './servicedate.js'
import type { TripUpdateRecord } from './observe.js'

/**
 * The corrected feed, on its own endpoint.
 *
 * `/v1/departures` is not touched by any of this. It serves the agency's raw times in the
 * SIRI envelope the app has always read, byte-compatible with builds that have been on
 * people's phones for months, and nothing in this file can change that. Corrections live
 * here, where a reader who wants them can ask and a widget that does not is unaffected.
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

async function readIndex(agency: string, stopId: string): Promise<RawDeparture[]> {
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
  const packed = segments.get(key)
  if (!packed) {
    return noEstimate()
  }
  return estimate(fromPacked(packed, bucket, now))
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
    if (segments.size > 0) cold = false

    const bucket = Math.floor(trip.stops[target].departure / 1800) % 60
    const block = await readBlockState(agency, serviceDate, entry.vehicleId, trip.blockId)

    const prediction =
      mode === 'off'
        ? null
        : predict({
            trip,
            serviceDate,
            now,
            target,
            agencyPrediction: entry.raw,
            profileFor: (i) => ladderFor(segments, trip, i, bucket, now),
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
