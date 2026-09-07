import { config } from './config.js'
import { redis } from './redis.js'

/** Read-through cache with request coalescing and stale-on-failure. */

/** In-flight requests, so concurrent misses for the same key share one upstream call. */
const inflight = new Map<string, Promise<unknown>>()

function staleKey(key: string): string {
  return `${key}:stale`
}

export type CacheOutcome = 'fresh' | 'hit' | 'stale' | 'coalesced'

export interface CacheResult<T> {
  value: T
  outcome: CacheOutcome
}

/** Returns a cached value, or computes and caches it. */
export async function cached<T>(
  key: string,
  ttl: number,
  fetch: () => Promise<T>,
): Promise<CacheResult<T>> {
  // 1. Fresh hit — the overwhelmingly common path in steady state.
  try {
    const hit = await redis.get(key)
    if (hit) return { value: JSON.parse(hit) as T, outcome: 'hit' }
  } catch (err) {
    // A dead cache degrades to a pass-through proxy rather than an outage. Noisy on
    // purpose: silently losing the cache is how you discover the key pool is empty.
    console.error(`[cache] read failed for ${key}:`, (err as Error).message)
  }

  // 2. Someone else is already fetching this exact key — wait on their result.
  const existing = inflight.get(key)
  if (existing) {
    return { value: (await existing) as T, outcome: 'coalesced' }
  }

  // 3. We own the fetch.
  const promise = fetch()
    .then(async (value) => {
      const encoded = JSON.stringify(value)
      try {
        await redis
          .pipeline()
          .set(key, encoded, 'EX', ttl)
          // The stale copy outlives the fresh one by design — it is what we serve
          // when 511 is down or the key pool is spent.
          .set(staleKey(key), encoded, 'EX', ttl * config.staleMultiplier)
          .exec()
      } catch (err) {
        console.error(`[cache] write failed for ${key}:`, (err as Error).message)
      }
      return value
    })
    .finally(() => {
      // Cleared in `finally`, not in `then`: a rejected fetch that stayed in the map
      // would make every future caller await a promise that already failed, turning
      // one transient upstream error into a permanent one for that key.
      inflight.delete(key)
    })

  inflight.set(key, promise)

  try {
    return { value: (await promise) as T, outcome: 'fresh' }
  } catch (err) {
    // 4. Upstream failed. Old data beats an error screen for a departures widget —
    // ninety-second-old times are still useful; a spinner is not.
    try {
      const stale = await redis.get(staleKey(key))
      if (stale) {
        console.warn(`[cache] serving stale ${key} after upstream failure`)
        return { value: JSON.parse(stale) as T, outcome: 'stale' }
      }
    } catch {
      // Fall through to the original error — the upstream failure is the more
      // useful thing to report.
    }
    throw err
  }
}
