import { redis } from './redis.js'
import { config } from './config.js'
import { encodeDeviation, decodeDeviation, type Deviation } from './deviation.js'

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
        JSON.stringify(encodeDeviation(d)),
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
        deviations.push(decodeDeviation(JSON.parse(raw)))
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
