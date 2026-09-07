import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { redis } from './redis.js'
import * as eventlog from './eventlog.js'
import * as store from './profilestore.js'
import * as warehouse from './warehouse.js'
import type { Deviation } from './deviation.js'
import { censoring, holdOpportunity, holdEvidence } from './deviation.js'
import { admissible, trainingWeight } from './outlier.js'
import { tierWeight, Tier } from './observe.js'
import {
  emptyCell,
  updateSeconds,
  type Cell,
  type Observation,
  type PackedSegment,
} from './profile.js'
import {
  observe as observeMoment,
  variance,
  robustScale,
  newHistogram,
  addToHistogram,
  fit,
  clampSlope,
  emptyMoments,
  emptyRegression,
  type Moments,
} from './stats.js'
import { asRate, corridorKey } from './schedule.js'
import { BUCKETS_PER_DAY, localDate, DayType } from './servicedate.js'
import { updateBlock, blockKey, type BlockState } from './blockstate.js'

/**
 * The learner: everything that turns observations into a profile.
 *
 * Runs on its own timer, under the same Redis lease the poller uses, and never inside a
 * poll cycle. Two learners doing read-modify-write on the same cells would double-count
 * with no symptom at all — every cell would simply shrink less than it should, everywhere,
 * forever — so the lease is not an optimisation.
 *
 * It is deliberately **stateless between ticks**. Holding the whole profile in memory would
 * be a few million cells and most of a gigabyte; a five-minute window touches on the order
 * of a couple of thousand, so reading exactly those, updating them and writing them back is
 * bounded work however large the profile grows.
 */

const LEADER_KEY = 'poller:leader'
const instanceId = randomUUID()

let learnTimer: NodeJS.Timeout | null = null
let publishTimer: NodeJS.Timeout | null = null
let running = false

export const learnerStats = {
  ticks: 0,
  observations: 0,
  admitted: 0,
  rejected: {} as Record<string, number>,
  cellsWritten: 0,
  routesPublished: 0,
  tripsWritten: 0,
  lastTickMs: 0,
  lastError: null as string | null,
}

/**
 * True when this process holds the *poller's* lease.
 *
 * Shares that lease rather than taking one of its own, deliberately: the instance that is
 * polling is the one accumulating the tracker state these observations came from, and two
 * separate elections could converge on two different instances — which is exactly the
 * double-count this design exists to avoid.
 */
async function holdsLease(pollerInstanceId: string | null): Promise<boolean> {
  if (!pollerInstanceId) return false
  try {
    return (await redis.get(LEADER_KEY)) === pollerInstanceId
  } catch {
    return false
  }
}

let leaseOwner: string | null = null

/** Told by the poller which instance id to check against. */
export function bindLease(pollerInstanceId: string): void {
  leaseOwner = pollerInstanceId
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/** Trips seen this window, accumulated into one row each. */
const pendingTrips = new Map<string, warehouse.TripObservationRow>()

/** Routes whose hot blob is out of date. */
const dirtyRoutes = new Set<string>()

async function tick(): Promise<void> {
  if (running) return
  if (!config.profile.enabled) return
  if (!warehouse.available()) return
  if (!(await holdsLease(leaseOwner))) return

  running = true
  const startedAt = Date.now()
  try {
    const cursor = await eventlog.readCursor()
    const { deviations, lastId } = await eventlog.drain(cursor)
    if (deviations.length === 0) return

    learnerStats.ticks++
    learnerStats.observations += deviations.length

    await learn(deviations)
    await eventlog.writeCursor(lastId)
    await flushTrips()
  } catch (err) {
    learnerStats.lastError = (err as Error).message
    console.error('[learner] tick failed:', (err as Error).message)
  } finally {
    running = false
    learnerStats.lastTickMs = Date.now() - startedAt
  }
}

/**
 * Folds a batch of observations into every rung of the ladder.
 *
 * Read the affected cells, update them in memory, write them back. The read is by exact key
 * rather than a scan, so the cost is proportional to what actually happened in the last few
 * minutes and not to how much history exists.
 */
async function learn(deviations: Deviation[]): Promise<void> {
  const usable: Deviation[] = []
  /** What the profile expected of each segment, before this batch moved it. */
  const expected = new Map<Deviation, number>()

  for (const d of deviations) {
    const verdict = admissible(d)
    if (!verdict.train) {
      const reason = verdict.reason ?? 'unknown'
      learnerStats.rejected[reason] = (learnerStats.rejected[reason] ?? 0) + 1
      // Still recorded, so the gap is visible and the incident dataset exists.
      accumulateTrip(d, false)
      continue
    }
    if (d.delta === undefined || !d.segmentKey || !d.segment) {
      accumulateTrip(d, true)
      continue
    }
    usable.push(d)
    accumulateTrip(d, true)
  }

  if (usable.length === 0) return
  learnerStats.admitted += usable.length

  await updateSegmentCells(usable, expected)
  await updatePooledCells(usable)
  await updateBlockStates(usable, expected)
}

/**
 * The three segment rungs: this half hour, this day type, and all time.
 *
 * Only the day-type rung keeps a histogram. Tail shape is a property of a segment and a day
 * type — the long tail of a PM-peak corridor looks the same at 17:15 as at 17:45 — and
 * storing one per half hour would be a gigabyte of the same curve written sixty times.
 */
async function updateSegmentCells(
  deviations: Deviation[],
  expected: Map<Deviation, number>,
): Promise<void> {
  type Key = Parameters<typeof warehouse.loadProfileCells>[0][number]
  const keys: Key[] = []
  const seen = new Set<string>()

  const push = (d: Deviation, dayType: number, bucket: number) => {
    const k: Key = {
      agency: d.agency,
      routeId: d.routeId,
      directionId: d.directionId,
      segmentKey: d.segmentKey!,
      dayType,
      bucket,
    }
    const s = warehouse.profileCellKey(k)
    if (seen.has(s)) return
    seen.add(s)
    keys.push(k)
  }

  for (const d of deviations) {
    push(d, d.dayType, d.bucket)
    push(d, d.dayType, -1)
    push(d, -1, -1)
  }

  const existing = await warehouse.loadProfileCells(keys)
  const cells = new Map<string, { row: warehouse.ProfileRow; cell: Cell }>()

  const cellFor = (d: Deviation, dayType: number, bucket: number) => {
    const row: warehouse.ProfileRow = {
      agency: d.agency,
      routeId: d.routeId,
      directionId: d.directionId,
      segmentKey: d.segmentKey!,
      dayType,
      bucket,
      n: 0,
      mean: 0,
      m2: 0,
      regW: 0,
      regSx: 0,
      regSy: 0,
      regSxx: 0,
      regSxy: 0,
      scheduledRun: d.scheduledRun,
      noiseVar: 0,
    }
    const id = warehouse.profileCellKey(row)
    let entry = cells.get(id)
    if (entry) return entry

    const prior = existing.get(id)
    const base = prior ?? row
    const cell: Cell = {
      moments: { n: base.n, mean: base.mean, m2: base.m2, updatedAt: 0 },
      regression: {
        w: base.regW,
        sx: base.regSx,
        sy: base.regSy,
        sxx: base.regSxx,
        sxy: base.regSxy,
        updatedAt: 0,
      },
      histogram: undefined,
      scheduledRun: base.scheduledRun || d.scheduledRun,
      noiseVariance: base.noiseVar,
    }
    if (bucket === -1 && dayType !== -1) {
      const h = newHistogram()
      if (prior?.histogram) for (let i = 0; i < h.length && i < prior.histogram.length; i++) h[i] = prior.histogram[i]
      cell.histogram = h
    }
    entry = { row: { ...base, scheduledRun: base.scheduledRun || d.scheduledRun }, cell }
    cells.set(id, entry)
    return entry
  }

  for (const d of deviations) {
    const decision = censoring(d)
    // A held departure is not evidence about how fast the segment ran; it is evidence
    // about a clock. `censoring` decides which value each model may see.
    if (decision.trainRunning === null) continue

    const at = d.actualDeparture ?? Math.floor(Date.now() / 1000)
    const dayCell = cellFor(d, d.dayType, -1)
    const scale = robustScale(dayCell.cell.histogram ?? newHistogram())
    // The cell's mean *before* this batch touches it: what the profile would have predicted
    // for this segment. That is the baseline the same-day block bias is measured against.
    const centre = dayCell.cell.moments.mean
    expected.set(d, centre)
    const weight = trainingWeight(d.delta!, centre, scale, tierWeight(d.tier, d.sigma))

    const o: Observation = {
      delta: d.delta!,
      // The regression's predictor is measured, so it carries error, and fitting on noisy
      // predictors biases the slope toward zero in a way that gets worse as the noise
      // grows. Only the two tiers where a vehicle reported itself are used for it; the
      // inferred ones would manufacture a recovery slope on exactly the routes whose
      // observations are worst.
      priorDev: d.tier <= Tier.A2 ? d.priorDev : undefined,
      scheduledRun: d.scheduledRun,
      weight,
      noiseVariance: 2 * d.sigma * d.sigma,
      at,
    }

    for (const [dayType, bucket] of [
      [d.dayType, d.bucket],
      [d.dayType, -1],
      [-1, -1],
    ] as [number, number][]) {
      const entry = cellFor(d, dayType, bucket)
      entry.cell = updateSeconds(entry.cell, o, bucket === -1 && dayType !== -1)
    }

    dirtyRoutes.add(`${d.agency}|${d.routeId}|${d.directionId}|${d.dayType}`)
  }

  const rows: warehouse.ProfileRow[] = []
  for (const { row, cell } of cells.values()) {
    rows.push({
      ...row,
      n: cell.moments.n,
      mean: cell.moments.mean,
      m2: cell.moments.m2,
      regW: cell.regression.w,
      regSx: cell.regression.sx,
      regSy: cell.regression.sy,
      regSxx: cell.regression.sxx,
      regSxy: cell.regression.sxy,
      scheduledRun: cell.scheduledRun,
      noiseVar: cell.noiseVariance,
      histogram: cell.histogram ? Array.from(cell.histogram) : null,
    })
  }
  learnerStats.cellsWritten += await warehouse.saveProfiles(rows)
}

/**
 * The pooled rungs, all held as rates.
 *
 * Thirty seconds means something different on a nine-kilometre hop than on a
 * two-hundred-metre one, so an average in seconds across a route is really an average of
 * whichever segments happen to be longest. A ratio to scheduled running time is
 * exchangeable, which is the only thing that makes these useful as a fallback for a
 * segment nobody has seen before.
 */
async function updatePooledCells(deviations: Deviation[]): Promise<void> {
  const plans: { table: string; keys: (string | number)[]; value: number; weight: number; at: number }[] = []

  for (const d of deviations) {
    if (d.delta === undefined || !d.segment) continue
    const rate = asRate(d.delta, d.scheduledRun)
    const weight = tierWeight(d.tier, d.sigma)
    const at = d.actualDeparture ?? Math.floor(Date.now() / 1000)

    plans.push({
      table: 'corridor_profile',
      keys: [d.agency, corridorKey(d.segment), d.dayType, d.bucket],
      value: rate,
      weight,
      at,
    })
    plans.push({
      table: 'route_profile',
      keys: [d.agency, d.routeId, d.directionId, d.dayType, d.bucket],
      value: rate,
      weight,
      at,
    })
    plans.push({
      table: 'stop_hold_profile',
      // Every occasion an early vehicle reached this stop, and whether it was let through.
      // Only early arrivals count -- a vehicle that was already on time would have left on
      // time either way and says nothing about whether the stop holds.
      keys: [d.agency, d.routeId, d.directionId, d.stopId],
      value: holdEvidence(d),
      weight: holdOpportunity(d) ? 1 : 0,
      at,
    })
    plans.push({
      table: 'agency_profile',
      // Three-hour periods, not half hours: the agency-wide fallback exists to always have
      // data, and dividing it sixty ways defeats that.
      keys: [d.agency, d.dayType, Math.floor(d.bucket / 6)],
      value: rate,
      weight,
      at,
    })
  }

  const byTable = new Map<string, typeof plans>()
  for (const p of plans) {
    const list = byTable.get(p.table)
    if (list) list.push(p)
    else byTable.set(p.table, [p])
  }

  for (const [table, items] of byTable) {
    const existing = await warehouse.loadMoments(table, items.map((i) => i.keys))
    const working = new Map<string, { keys: (string | number)[]; m: Moments }>()

    for (const item of items) {
      const id = warehouse.momentKey(table, item.keys)
      let entry = working.get(id)
      if (!entry) {
        const prior = existing.get(id)
        entry = {
          keys: item.keys,
          m: prior ? { n: prior.n, mean: prior.mean, m2: prior.m2, updatedAt: 0 } : emptyMoments(0),
        }
        working.set(id, entry)
      }
      entry.m = observeMoment(entry.m, item.value, item.at, item.weight, config.profile.halfLifeDays)
    }

    await warehouse.saveMoments(
      table,
      [...working.values()].map((e) => ({ keys: e.keys, n: e.m.n, mean: e.m.mean, m2: e.m.m2 })),
    )
  }
}

// ---------------------------------------------------------------------------
// Block state
// ---------------------------------------------------------------------------

const BLOCK_PREFIX = 'live:block:'

/** Kept past end of service so an owl run does not lose its bias at midnight. */
const BLOCK_TTL_SECONDS = 8 * 3600

async function updateBlockStates(
  deviations: Deviation[],
  expected: Map<Deviation, number>,
): Promise<void> {
  const byKey = new Map<string, Deviation[]>()
  for (const d of deviations) {
    const key = blockKey(d.vehicleId, d.blockId)
    if (!key) continue
    const id = `${d.agency}:${d.serviceDate}:${key}`
    const list = byKey.get(id)
    if (list) list.push(d)
    else byKey.set(id, [d])
  }
  if (byKey.size === 0) return

  try {
    const ids = [...byKey.keys()]
    const raw = await redis.mget(ids.map((id) => BLOCK_PREFIX + id))
    const pipe = redis.pipeline()

    ids.forEach((id, i) => {
      let state: BlockState | null = null
      try {
        state = raw[i] ? (JSON.parse(raw[i]!) as BlockState) : null
      } catch {
        state = null
      }

      const list = byKey.get(id)!.sort((a, b) => (a.actualDeparture ?? 0) - (b.actualDeparture ?? 0))
      for (const d of list) {
        if (d.delta === undefined) continue
        state = updateBlock(
          state,
          {
            serviceDate: d.serviceDate,
            tripId: d.tripId,
            at: d.actualDeparture ?? 0,
            dev: d.devDeparture,
            delta: d.delta,
            // Compared against the segment's own long-run mean, not against zero. Against
            // zero, a bus on a genuinely slow corridor looks like a slow driver, and the
            // corridor's congestion is then projected forward a second time on top of the
            // profile that already contains it.
            expected: expected.get(d) ?? 0,
          },
          blockKey(d.vehicleId, d.blockId)!,
        )
      }

      if (state) pipe.set(BLOCK_PREFIX + id, JSON.stringify(state), 'EX', BLOCK_TTL_SECONDS)
    })

    await pipe.exec()
  } catch (err) {
    console.error('[learner] block state update failed:', (err as Error).message)
  }
}

/** Reads one vehicle's same-day bias, for the prediction path. */
export async function readBlockState(
  agency: string,
  serviceDate: string,
  vehicleId?: string,
  blockId?: string,
): Promise<BlockState | null> {
  const key = blockKey(vehicleId, blockId)
  if (!key) return null
  try {
    const raw = await redis.get(`${BLOCK_PREFIX}${agency}:${serviceDate}:${key}`)
    return raw ? (JSON.parse(raw) as BlockState) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Trip rows
// ---------------------------------------------------------------------------

function accumulateTrip(d: Deviation, admitted: boolean): void {
  const id = `${d.serviceDate}|${d.tripId}`
  let row = pendingTrips.get(id)
  if (!row) {
    row = {
      serviceDate: d.serviceDate,
      agency: d.agency,
      tripId: d.tripId,
      routeId: d.routeId,
      directionId: d.directionId,
      patternId: d.patternId,
      blockId: d.blockId,
      vehicleId: d.vehicleId ?? '',
      seqs: [],
      stopIds: [],
      schedDep: [],
      actDep: [],
      actArr: [],
      devDep: [],
      delta: [],
      tiers: [],
      held: [],
      predErr: [],
      anomalous: !admitted,
    }
    pendingTrips.set(id, row)
  }

  row.seqs.push(d.seq)
  row.stopIds.push(d.stopId)
  row.schedDep.push(d.scheduledDeparture)
  row.actDep.push(d.actualDeparture ?? 0)
  row.actArr.push(d.actualArrival ?? 0)
  row.devDep.push(Math.round(d.devDeparture))
  row.delta.push(d.delta === undefined ? warehouse.ABSENT : Math.round(d.delta))
  row.tiers.push(d.tier)
  row.held.push(d.held)

  // The agency's error at each horizon it was watched at. The sentinel is not zero: a
  // horizon nobody observed is absent, and reading it as a perfect prediction would flatter
  // the agency's predictor exactly where we know least about it.
  for (const p of d.predictions) {
    row.predErr.push(p.horizon, Math.round((d.actualDeparture ?? 0) - p.predicted))
  }
}

/**
 * Writes out trips that have stopped moving.
 *
 * Assembled in memory and written once rather than upserted per stop: a forty-stop trip
 * observed over ninety minutes would otherwise rewrite a growing row forty times, which is
 * write amplification for no benefit — nothing reads a partial trip.
 */
async function flushTrips(force = false): Promise<void> {
  if (pendingTrips.size === 0) return
  const now = Math.floor(Date.now() / 1000)
  const ready: warehouse.TripObservationRow[] = []

  for (const [id, row] of pendingTrips) {
    const last = row.actDep[row.actDep.length - 1] ?? 0
    if (force || now - last > 900) {
      ready.push(row)
      pendingTrips.delete(id)
    }
  }

  if (ready.length === 0) return
  learnerStats.tripsWritten += await warehouse.writeTripObservations(ready)
}

// ---------------------------------------------------------------------------
// Publishing the hot profile
// ---------------------------------------------------------------------------

/**
 * Rebuilds the Redis blobs for routes whose cells have moved.
 *
 * Only the dirty ones. A full republish of every route every five minutes would be tens of
 * megabytes of Redis writes an hour to change a handful of numbers.
 */
async function publish(): Promise<void> {
  if (!warehouse.available() || !(await holdsLease(leaseOwner))) return
  if (dirtyRoutes.size === 0) return

  const routes = [...dirtyRoutes]
  dirtyRoutes.clear()

  for (const id of routes) {
    const [agency, routeId, dir, dayType] = id.split('|')
    try {
      const cells = await warehouse.loadRouteCells(agency, routeId, Number(dir), Number(dayType))
      if (cells.length === 0) continue
      // Hold rates are not day-type-specific: whether a stop waits for an early vehicle is
      // a property of the stop and the operator's practice, not of the day of the week.
      const holds = await warehouse.loadHoldRates(agency, routeId, Number(dir))

      const bySegment = new Map<string, PackedSegment>()
      for (const c of cells) {
        // The key stored in the blob drops the agency, route and direction, which are
        // already in the Redis key. Across thousands of segments that is most of the string
        // bytes in the file.
        const short = c.segmentKey.split('|').slice(3).join('|')
        let seg = bySegment.get(short)
        if (!seg) {
          // The destination stop is what a hold applies to, and it is the second half of
          // the segment key.
          const toStop = (short.split('>')[1] ?? '').split('#')[0]
          const hold = holds.get(toStop)
          seg = {
            key: short,
            scheduledRun: c.scheduledRun,
            slope: 0,
            meanAll: 0,
            sdAll: 0,
            nAll: 0,
            holdRate: hold?.rate ?? 0,
            holdN: hold?.n ?? 0,
            buckets: new Array(BUCKETS_PER_DAY).fill(null),
          }
          bySegment.set(short, seg)
        }

        const sd = c.n > 0 ? Math.sqrt(Math.max(0, c.m2 / c.n)) : 0
        if (c.bucket === -1) {
          seg.meanAll = c.mean
          seg.sdAll = sd
          seg.nAll = c.n
          seg.scheduledRun = c.scheduledRun || seg.scheduledRun
          const f = fit({
            w: c.regW, sx: c.regSx, sy: c.regSy, sxx: c.regSxx, sxy: c.regSxy, updatedAt: 0,
          })
          seg.slope = f.n >= 8 ? clampSlope(f.slope) : 0
        } else if (c.bucket >= 0 && c.bucket < BUCKETS_PER_DAY) {
          seg.buckets[c.bucket] = { mean: c.mean, sd, n: c.n }
        }
      }

      await store.publish(agency, routeId, Number(dir), Number(dayType) as DayType, [...bySegment.values()])
      learnerStats.routesPublished++
    } catch (err) {
      console.error(`[learner] publish failed for ${id}:`, (err as Error).message)
      // Put it back so the next pass retries rather than leaving a stale blob forever.
      dirtyRoutes.add(id)
    }
  }

  await store.bumpVersion()
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let dailyDate = ''

async function daily(): Promise<void> {
  const today = localDate(Date.now())
  if (today === dailyDate) return
  if (!(await holdsLease(leaseOwner))) return
  dailyDate = today
  await warehouse.rollPartitions(today)
}

export function startLearner(pollerInstanceId: string): void {
  bindLease(pollerInstanceId)

  if (!config.profile.enabled) {
    console.info('[learner] disabled by configuration')
    return
  }
  if (!warehouse.configured()) {
    console.info('[learner] no DATABASE_URL; observations will not be learned from')
    return
  }

  console.info(
    `[learner] profiling ${config.profile.agencies.join(', ')}; folding every ` +
      `${config.profile.learnIntervalSeconds}s, publishing every ` +
      `${config.profile.learnIntervalSeconds * 2}s`,
  )

  learnTimer = setInterval(() => {
    void tick().then(() => daily())
  }, config.profile.learnIntervalSeconds * 1000)

  publishTimer = setInterval(() => {
    void publish()
  }, config.profile.learnIntervalSeconds * 2000)
}

export async function stopLearner(): Promise<void> {
  if (learnTimer) { clearInterval(learnTimer); learnTimer = null }
  if (publishTimer) { clearInterval(publishTimer); publishTimer = null }
  // Everything in flight is written down before exiting: a deploy should cost nothing.
  try {
    await flushTrips(true)
  } catch {
    // The stream still holds the observations; the next learner will pick them up.
  }
}

export interface LearnerStatus {
  enabled: boolean
  leader: boolean
  ticks: number
  observations: number
  admitted: number
  rejected: Record<string, number>
  cellsWritten: number
  routesPublished: number
  tripsWritten: number
  pendingTrips: number
  dirtyRoutes: number
  streamDepth: number
  lastTickMs: number
  lastError: string | null
}

export async function learnerStatus(): Promise<LearnerStatus> {
  return {
    enabled: config.profile.enabled && warehouse.configured(),
    leader: await holdsLease(leaseOwner),
    ...learnerStats,
    pendingTrips: pendingTrips.size,
    dirtyRoutes: dirtyRoutes.size,
    streamDepth: await eventlog.depth(),
  }
}

// Kept exported so the tests and the backfill tool can drive one tick directly.
export { tick as learnerTick, publish as learnerPublish, learn as learnFrom }
