import * as warehouse from './warehouse.js'
import { horizonBucket } from './drift.js'
import type { AgencyErrorProfile } from './predict.js'

/**
 * The learned drift, in memory, on the prediction path.
 *
 * `drift.ts` measures how a producer's estimate moves as an arrival closes and folds it
 * into `prediction_error`. This is the other end: the lookup `predict.ts` consults to
 * correct the agency's number before fusing it.
 *
 * Held in memory and refreshed on a timer, never queried per request. The table is moments
 * only — six key columns and three numbers — so the whole learned set is small, and the
 * rule that no response waits on Postgres is not negotiable.
 *
 * ## Two rungs, not seven
 *
 * `profile.ts` needs a seven-rung shrinkage ladder because a segment cell is starved of
 * evidence and has to borrow from its parents. This does not have that problem: a route
 * produces hundreds of drift samples an hour, so a route-level cell is well-evidenced
 * within days.
 *
 * So there are two rungs. The route cell where one exists, and an agency-wide pooled cell
 * where it does not — which covers a route that started yesterday, and every route on the
 * nineteen agencies that will never have a segment profile.
 */

/** Below this, a cell has not earned the right to move a prediction. */
const MIN_SAMPLES = 20

interface Cell {
  n: number
  mean: number
  variance: number
}

let byRoute = new Map<string, Cell>()
let byAgency = new Map<string, Cell>()
let loadedAt = 0
let cells = 0

const routeKey = (agency: string, routeId: string, dir: number, horizon: number, dayType: number, period: number) =>
  `${agency}\x1f${routeId}\x1f${dir}\x1f${horizon}\x1f${dayType}\x1f${period}`

const agencyKey = (agency: string, horizon: number, dayType: number, period: number) =>
  `${agency}\x1f${horizon}\x1f${dayType}\x1f${period}`

/**
 * Rebuilds the in-memory view from Postgres.
 *
 * Safe to call on a timer and safe to fail: on any error the previous view is kept, since
 * a stale correction is worth more than no correction and far more than a thrown request.
 */
export async function refresh(): Promise<number> {
  try {
    const rows = await warehouse.loadDrift(MIN_SAMPLES / 4)
    if (rows.length === 0 && byRoute.size > 0) return byRoute.size

    const route = new Map<string, Cell>()
    // Pooled across routes, accumulated as decayed moments rather than a mean of means —
    // a route with 4,000 samples should not carry the same weight as one with 40.
    const pooled = new Map<string, { n: number; sum: number; m2: number }>()

    for (const r of rows) {
      route.set(routeKey(r.agency, r.routeId, r.directionId, r.horizon, r.dayType, r.period), {
        n: r.n,
        mean: r.mean,
        variance: r.n > 0 ? r.m2 / r.n : 0,
      })

      const ak = agencyKey(r.agency, r.horizon, r.dayType, r.period)
      const acc = pooled.get(ak) ?? { n: 0, sum: 0, m2: 0 }
      acc.n += r.n
      acc.sum += r.mean * r.n
      acc.m2 += r.m2
      pooled.set(ak, acc)
    }

    const agency = new Map<string, Cell>()
    for (const [k, acc] of pooled) {
      if (acc.n <= 0) continue
      agency.set(k, { n: acc.n, mean: acc.sum / acc.n, variance: acc.m2 / acc.n })
    }

    byRoute = route
    byAgency = agency
    loadedAt = Date.now()
    cells = rows.length
    return rows.length
  } catch (err) {
    console.error('[agencyerror] refresh failed:', (err as Error).message)
    return byRoute.size
  }
}

/**
 * The correction to apply to an agency's prediction, or undefined to leave it alone.
 *
 * `horizonSeconds` is how far out the prediction is being made — the same quantity
 * `drift.ts` bucketed when it learned this. Returning undefined leaves `predict.ts` on its
 * pessimistic default variance, which is the correct behaviour for a producer we have not
 * measured: it stays in the fusion, but it cannot dominate it.
 */
export function lookup(
  agency: string,
  routeId: string,
  directionId: number,
  horizonSeconds: number,
  dayType: number,
  period: number,
): AgencyErrorProfile | undefined {
  const horizon = horizonBucket(Math.max(0, horizonSeconds))

  const exact = byRoute.get(routeKey(agency, routeId, directionId, horizon, dayType, period))
  if (exact && exact.n >= MIN_SAMPLES) {
    return { mean: exact.mean, variance: Math.max(100, exact.variance), n: exact.n }
  }

  const pooled = byAgency.get(agencyKey(agency, horizon, dayType, period))
  if (pooled && pooled.n >= MIN_SAMPLES) {
    return { mean: pooled.mean, variance: Math.max(100, pooled.variance), n: pooled.n }
  }

  return undefined
}

export function status() {
  return {
    cells,
    routes: byRoute.size,
    agencyPooled: byAgency.size,
    ageSeconds: loadedAt ? Math.floor((Date.now() - loadedAt) / 1000) : null,
  }
}
