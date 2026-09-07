import { Redis } from 'ioredis'
import { config } from './config.js'

/** One shared connection for the whole process. */
export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  // Railway's Redis lives on the private network; a brief blip at deploy time
  // shouldn't take the API down with it.
  retryStrategy: (attempt: number) => Math.min(attempt * 200, 2000),
})

redis.on('error', (err: Error) => {
  // Logged, not thrown: callers handle a dead cache by falling through to upstream.
  console.error('[redis] connection error:', err.message)
})
