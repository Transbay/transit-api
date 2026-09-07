import { config } from './config.js'
import { redis } from './redis.js'

// Picks which key in the pool spends the next request, and books it against the
// hourly budget. Fails closed: no counter means no request.

export class NoKeyAvailableError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super('All 511 API keys have exhausted their hourly budget')
    this.name = 'NoKeyAvailableError'
  }
}

/** Raised when the budget counter itself can't be reached. */
export class BudgetUnavailableError extends Error {
  constructor(cause: string) {
    super(`Cannot reach the request-budget counter: ${cause}`)
    this.name = 'BudgetUnavailableError'
  }
}

/** A fixed-window counter keyed by the wall-clock hour. */
function counterKey(keyIndex: number): string {
  const hourBucket = Math.floor(Date.now() / 3_600_000)
  return `511:budget:${hourBucket}:${keyIndex}`
}

function secondsUntilNextHour(): number {
  return Math.ceil((3_600_000 - (Date.now() % 3_600_000)) / 1000)
}

/**
 * Reserves one request against the least-used key that still has headroom, and returns that
 * key.
 */
export async function reserveKey(): Promise<{ key: string; index: number }> {
  const { keys, hourlyLimitPerKey } = config.fiveEleven

  const usage = await readUsage()

  // Least-used first. Ties break toward the lower index, which is fine — the next
  // call will see the incremented count and move on.
  let bestIndex = -1
  let bestUsage = Number.POSITIVE_INFINITY
  for (let i = 0; i < keys.length; i++) {
    if (usage[i] < hourlyLimitPerKey && usage[i] < bestUsage) {
      bestUsage = usage[i]
      bestIndex = i
    }
  }

  if (bestIndex === -1) throw new NoKeyAvailableError(secondsUntilNextHour())

  // INCR then EXPIRE. The TTL is set every time rather than only on creation — an
  // extra command, but it means a key can never end up immortal because the process
  // died between the two.
  const bucketKey = counterKey(bestIndex)
  const written = await redis.pipeline().incr(bucketKey).expire(bucketKey, 3600 + 60).exec()
  // A reservation we failed to record is a request we'd spend without counting, so
  // this is checked as carefully as the read.
  assertPipelineSucceeded(written)

  return { key: keys[bestIndex], index: bestIndex }
}

/** Reads every key's spend in one round trip. */
async function readUsage(): Promise<number[]> {
  const { keys } = config.fiveEleven
  let results
  try {
    results = await redis
      .pipeline(keys.map((_, i) => ['get', counterKey(i)] as [string, string]))
      .exec()
  } catch (err) {
    throw new BudgetUnavailableError((err as Error).message)
  }
  assertPipelineSucceeded(results)

  return keys.map((_, i) => {
    const raw = results![i]![1]
    return typeof raw === 'string' ? Number(raw) : 0
  })
}

type PipelineResult = [Error | null, unknown][] | null

function assertPipelineSucceeded(results: PipelineResult): asserts results is [Error | null, unknown][] {
  if (!results) throw new BudgetUnavailableError('pipeline returned no results')
  for (const entry of results) {
    if (entry?.[0]) throw new BudgetUnavailableError(entry[0].message)
  }
}

/** Current spend per key, for the /health endpoint. Never returns the keys themselves. */
export async function budgetSnapshot(): Promise<
  { index: number; used: number; limit: number }[]
> {
  const { hourlyLimitPerKey } = config.fiveEleven
  const usage = await readUsage()
  return usage.map((used, index) => ({ index, used, limit: hourlyLimitPerKey }))
}
