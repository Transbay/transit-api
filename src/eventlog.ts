import { redis } from './redis.js'
import { config } from './config.js'
import type { Deviation } from './deviation.js'

/**
 * The durable hand-off between the poller and the learner.
 *
 * A Redis stream, capped, and that choice is what makes the warehouse genuinely optional
 * rather than optional-in-principle. The poller appends and never waits; the learner drains
 * on its own timer; Postgres being down costs history rather than availability, and Redis
 * being down costs history rather than departures. Nothing in the fifteen-second cycle ever
 * blocks on a database.
 *
 * The cap is the rule "losing history is always preferable to delaying a departure",
 * written as a number. When the learner falls behind, the oldest observations are dropped
 * and a counter says how many — which is a bad day for the profile and an ordinary one for
 * everybody using the app.
 */

const STREAM = 'obs:stream'

export const eventLogStats = {
  appended: 0,
  drained: 0,
  appendFailures: 0,
  drainFailures: 0,
  lastId: '0-0',
}

/**
 * Appends observations. Fire and forget by design.
 *
 * Errors are counted and swallowed. This is called from inside the poll cycle, and the
 * cycle's job is to publish departures — an observation that cannot be recorded is a gap
 * in a dataset, not a failure of the service.
 */
export async function append(deviations: Deviation[]): Promise<void> {
  if (deviations.length === 0) return
  try {
    const pipe = redis.pipeline()
    for (const d of deviations) {
      pipe.xadd(
        STREAM,
        'MAXLEN',
        '~',
        String(config.profile.streamMaxLen),
        '*',
        'd',
        JSON.stringify(encode(d)),
      )
    }
    await pipe.exec()
    eventLogStats.appended += deviations.length
  } catch (err) {
    eventLogStats.appendFailures += deviations.length
    console.error('[eventlog] append failed:', (err as Error).message)
  }
}

export interface DrainResult {
  deviations: Deviation[]
  lastId: string
}

/**
 * Reads everything since `fromId`.
 *
 * `XRANGE` rather than a consumer group: there is exactly one learner, elected by the same
 * Redis lease the poller uses, and a consumer group would add acknowledgement bookkeeping
 * to solve a problem we do not have. The cursor is kept in Redis so a restart resumes
 * rather than re-reading the whole stream.
 */
export async function drain(fromId: string, max = 5000): Promise<DrainResult> {
  try {
    const exclusive = fromId === '0-0' ? '-' : `(${fromId}`
    const rows = (await redis.xrange(STREAM, exclusive, '+', 'COUNT', max)) as [
      string,
      string[],
    ][]

    const deviations: Deviation[] = []
    let lastId = fromId
    for (const [id, fields] of rows) {
      lastId = id
      const raw = fields[1]
      if (!raw) continue
      try {
        deviations.push(decode(JSON.parse(raw)))
      } catch {
        // One malformed entry must not stop the drain; the cursor has already advanced
        // past it, so it is skipped rather than retried forever.
      }
    }

    eventLogStats.drained += deviations.length
    eventLogStats.lastId = lastId
    return { deviations, lastId }
  } catch (err) {
    eventLogStats.drainFailures++
    console.error('[eventlog] drain failed:', (err as Error).message)
    return { deviations: [], lastId: fromId }
  }
}

const CURSOR_KEY = 'obs:cursor'

export async function readCursor(): Promise<string> {
  try {
    return (await redis.get(CURSOR_KEY)) ?? '0-0'
  } catch {
    return '0-0'
  }
}

export async function writeCursor(id: string): Promise<void> {
  try {
    await redis.set(CURSOR_KEY, id)
  } catch {
    // A lost cursor re-reads at most the stream's length, which is bounded and harmless:
    // profile updates are idempotent in the only sense that matters here, because the
    // learner writes whole cells rather than increments.
  }
}

export async function depth(): Promise<number> {
  try {
    return await redis.xlen(STREAM)
  } catch {
    return -1
  }
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * Short keys, because this is the highest-volume thing in the system.
 *
 * A quarter of a million entries a day at forty bytes of key names apiece is ten megabytes
 * a day of field names — in a capped stream, that is entries evicted for nothing.
 */
interface Wire {
  a: string
  t: string
  r: string
  di: number
  p: string
  b: string
  v?: string
  sd: string
  s: string
  q: number
  sa: number
  sp: number
  aa?: number
  ap: number
  da?: number
  dp: number
  pd?: number
  dl?: number
  dw?: number
  sk?: string
  sr: number
  bk: number
  dt: number
  tp: number
  hd: number
  ti: number
  sg: number
  co: number
  pr: [number, number][]
}

function encode(d: Deviation): Wire {
  return {
    a: d.agency,
    t: d.tripId,
    r: d.routeId,
    di: d.directionId,
    p: d.patternId,
    b: d.blockId,
    v: d.vehicleId,
    sd: d.serviceDate,
    s: d.stopId,
    q: d.seq,
    sa: d.scheduledArrival,
    sp: d.scheduledDeparture,
    aa: d.actualArrival,
    ap: d.actualDeparture ?? 0,
    da: d.devArrival,
    dp: d.devDeparture,
    pd: d.priorDev,
    dl: d.delta,
    dw: d.dwell,
    sk: d.segmentKey,
    sr: d.scheduledRun,
    bk: d.bucket,
    dt: d.dayType,
    tp: d.timepoint ? 1 : 0,
    hd: d.held ? 1 : 0,
    ti: d.tier,
    sg: d.sigma,
    co: d.composite ? 1 : 0,
    pr: d.predictions.map((p) => [p.horizon, p.predicted]),
  }
}

function decode(w: Wire): Deviation {
  return {
    agency: w.a,
    tripId: w.t,
    routeId: w.r,
    directionId: w.di,
    patternId: w.p,
    blockId: w.b,
    vehicleId: w.v,
    serviceDate: w.sd,
    stopId: w.s,
    seq: w.q,
    scheduledArrival: w.sa,
    scheduledDeparture: w.sp,
    actualArrival: w.aa,
    actualDeparture: w.ap,
    devArrival: w.da,
    devDeparture: w.dp,
    priorDev: w.pd,
    delta: w.dl,
    dwell: w.dw,
    segmentKey: w.sk,
    scheduledRun: w.sr,
    bucket: w.bk,
    dayType: w.dt,
    timepoint: w.tp === 1,
    held: w.hd === 1,
    tier: w.ti,
    sigma: w.sg,
    composite: w.co === 1,
    predictions: w.pr.map(([horizon, predicted]) => ({ horizon, predicted })),
  }
}
