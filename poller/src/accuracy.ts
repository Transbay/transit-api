import { redis } from './redis.js'
import { config } from './config.js'
import { readIndex, indexExists, type PredictionResponse } from './predictions.js'
import * as warehouse from './warehouse.js'
import { decide, horizonBucket } from './accuracyrules.js'

/**
 * Random spot checks: was the learned time actually right?
 *
 * Now and then, a prediction someone asked for is set aside. When its vehicle leaves the
 * stop, the agency's last word on when it would depart -- the best the feed ever knew -- is
 * taken as what happened, and both numbers are scored against it: the agency's at the
 * moment we predicted, and ours. The scores land in `model_score`, which is what
 * `/v1/profile/scores` shows and what `isProven` reads before a correction may be shown.
 *
 * Built not to cost memory. Only predictions that were already computed for a request are
 * sampled, so no stop is predicted for the sake of checking it. Pending checks live in one
 * capped Redis hash, not in this process. Resolved checks go straight to Postgres, and the
 * scoring is a SQL aggregate. What this process holds is one tick's worth of the hash and
 * a handful of scoreboard rows.
 */

const PENDING_KEY = 'accuracy:pending'

interface Pending {
  a: string
  s: string
  t: string
  l: string
  /** When the prediction was made, epoch seconds. */
  at: number
  /** The agency's time when we predicted. */
  raw: number
  /** Our estimate and its band. */
  p50: number
  p10: number
  p90: number
  n: number
  c: string
  /** The agency's latest time for this trip here, and when we last saw it listed. */
  last: number
  seenAt: number
}

export const accuracyStats = {
  sampled: 0,
  resolved: 0,
  /** Left the feed long before it was due: dropped, since nothing says when it left. */
  vanished: 0,
  expired: 0,
  pending: 0,
  lastTickAt: null as string | null,
}

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000)

/**
 * Maybe set aside one prediction from a response that was computed anyway.
 *
 * Only one the model had evidence for (anything else is the agency's number with a label
 * on it), and only from two minutes to thirty out: nearer has no time left to be wrong in,
 * and further is mostly the timetable. Scored by horizon, so the near-term corrections a
 * rider acts on are judged separately from the far ones.
 */
export function maybeSample(response: PredictionResponse): void {
  const { sampleRate, maxPending } = config.accuracy
  if (sampleRate <= 0 || Math.random() >= sampleRate) return

  const now = Math.floor(Date.now() / 1000)
  const eligible = response.predictions.filter((p) => {
    const ahead = sec(p.raw) - now
    return (
      (p.evidence?.samples ?? 0) >= config.predictions.minSamples &&
      ahead >= Math.max(120, config.predictions.minHorizonSeconds) &&
      ahead <= 1800
    )
  })
  if (eligible.length === 0) return
  const p = eligible[Math.floor(Math.random() * eligible.length)]

  const record: Pending = {
    a: response.agency,
    s: response.stopCode,
    t: p.tripId,
    l: p.lineRef,
    at: now,
    raw: sec(p.raw),
    p50: sec(p.p50),
    p10: sec(p.p10),
    p90: sec(p.p90),
    n: p.evidence.samples,
    c: p.confidence,
    last: sec(p.raw),
    seenAt: now,
  }

  // Fire and forget: a lost sample is nothing, and a request must never wait on this.
  void (async () => {
    try {
      if ((await redis.hlen(PENDING_KEY)) >= maxPending) return
      // HSETNX: the first prediction for a trip at a stop is the one that gets checked.
      const added = await redis.hsetnx(PENDING_KEY, `${record.a}|${record.s}|${record.t}`,
        JSON.stringify(record))
      if (added) accuracyStats.sampled++
    } catch {
      // Redis is having a moment; skip this one.
    }
  })()
}

/** One pass over the pending checks. */
export async function tick(now = Math.floor(Date.now() / 1000)): Promise<void> {
  const all = await redis.hgetall(PENDING_KEY)
  accuracyStats.pending = Object.keys(all).length
  accuracyStats.lastTickAt = new Date(now * 1000).toISOString()
  if (accuracyStats.pending === 0) return

  // One index read per stop, and one existence check per agency, however many checks share them.
  const byStop = new Map<string, [string, Pending][]>()
  for (const [field, json] of Object.entries(all)) {
    let p: Pending
    try {
      p = JSON.parse(json) as Pending
    } catch {
      await redis.hdel(PENDING_KEY, field)
      continue
    }
    const k = `${p.a}|${p.s}`
    const list = byStop.get(k)
    if (list) list.push([field, p])
    else byStop.set(k, [[field, p]])
  }

  const live = new Map<string, boolean>()
  const updates: string[] = []
  const done: string[] = []

  for (const checks of byStop.values()) {
    const { a, s } = checks[0][1]
    if (!live.has(a)) live.set(a, await indexExists(a))
    // The feed has gone quiet: absence means nothing. Wait for it to come back.
    if (!live.get(a)) continue

    const listed = new Map((await readIndex(a, s)).map((e) => [e.tripId, e.raw]))

    for (const [field, p] of checks) {
      const latest = listed.get(p.t)
      const what = decide(p, latest, now)
      if (what === 'seen') {
        p.last = latest!
        p.seenAt = now
        updates.push(field, JSON.stringify(p))
      } else if (what === 'departed') {
        done.push(field)
        accuracyStats.resolved++
        await warehouse.saveAccuracyCheck({
          agency: p.a,
          stopId: p.s,
          tripId: p.t,
          lineRef: p.l,
          madeAt: p.at,
          horizonS: p.last - p.at,
          rawError: p.raw - p.last,
          modelError: p.p50 - p.last,
          inBand: p.p10 <= p.last && p.last <= p.p90,
          samples: p.n,
          confidence: p.c,
        })
      } else if (what === 'vanished' || what === 'expired') {
        done.push(field)
        accuracyStats[what]++
      }
    }
  }

  if (updates.length) await redis.hset(PENDING_KEY, ...updates)
  if (done.length) await redis.hdel(PENDING_KEY, ...done)
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

let scores = new Map<string, { n: number; rawMedian: number; corrMedian: number }>()

async function refreshScores(): Promise<void> {
  const rows = await warehouse.recentScores()
  scores = new Map(rows.map((r) => [`${r.agency}|${r.horizon}`, r]))
}

/**
 * Whether spot checks say our time beats the agency's for this agency, this far out.
 *
 * "Proven" means enough checks over the last fortnight, with our median miss smaller than
 * the agency's. Anything short of that is not shown in the app, however confident the
 * model is about itself.
 */
export function isProven(agency: string, secondsAhead: number): boolean {
  const s = scores.get(`${agency}|${horizonBucket(secondsAhead)}`)
  return Boolean(s && s.n >= config.accuracy.minChecks && s.corrMedian < s.rawMedian)
}

/** The scoreboard as the gate sees it, for `/health`. */
export function provenCells(): string[] {
  return [...scores.entries()]
    .filter(([k]) => {
      const [agency, h] = k.split('|')
      return isProven(agency, Number(h) * 60)
    })
    .map(([k]) => k)
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let tickTimer: NodeJS.Timeout | null = null
let rollTimer: NodeJS.Timeout | null = null

/**
 * Starts checking. `isLeader` keeps a second replica from resolving the same checks twice;
 * every replica still refreshes its own copy of the scoreboard, since every replica serves.
 */
export function startAccuracy(isLeader: () => Promise<boolean>): void {
  const guard = (label: string, fn: () => Promise<void>) => () =>
    void fn().catch((err) => console.warn(`[accuracy] ${label} failed:`, (err as Error).message))

  tickTimer = setInterval(guard('tick', async () => {
    if (await isLeader()) await tick()
  }), 30_000)

  rollTimer = setInterval(guard('roll-up', async () => {
    if (await isLeader()) await warehouse.rollUpAccuracy()
    await refreshScores()
  }), 600_000)

  void guard('scores', refreshScores)()
}

export function stopAccuracy(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
  if (rollTimer) { clearInterval(rollTimer); rollTimer = null }
}
