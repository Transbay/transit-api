import { config } from './config.js'

/**
 * Keeps a shown correction shown, so a time does not flicker in and out of purple.
 *
 * A correction hovering around the threshold -- 32 seconds, then 28, then 31 -- would
 * otherwise toggle on every refresh, which is exactly the constant minute-by-minute
 * adjusting a rider should never see. So the bar to *start* showing one is
 * `minCorrectionSeconds`; once shown for a trip at a stop, it stays until it falls below
 * half of that.
 *
 * Keyed by agency, stop and trip, only for stops someone asked about. Bounded: entries go
 * after half an hour unseen, and past `MAX_ENTRIES` the least recently seen go first, so
 * this is a couple of megabytes at most.
 */

const TTL_MS = 30 * 60 * 1000
const MAX_ENTRIES = 20_000

const shown = new Map<string, number>()

export function worthShowing(key: string, correctionSeconds: number, now = Date.now()): boolean {
  const since = shown.get(key)
  const showing = since !== undefined && now - since < TTL_MS
  const floor = config.predictions.minCorrectionSeconds * (showing ? 0.5 : 1)

  if (Math.abs(correctionSeconds) < floor) {
    shown.delete(key)
    return false
  }
  // Re-inserted so the Map's insertion order is least-recently-seen first.
  shown.delete(key)
  shown.set(key, now)
  while (shown.size > MAX_ENTRIES) shown.delete(shown.keys().next().value!)
  return true
}

export function steadyKey(agency: string, stopCode: string, tripId: string): string {
  return `${agency}|${stopCode}|${tripId}`
}
