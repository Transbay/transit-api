import { config } from './config.js'
import { redis } from './redis.js'
import * as warehouse from './warehouse.js'
import { rebuildSchedule } from './schedulefeed.js'

/**
 * The nightly schedule build, as its own process.
 *
 * It runs separately from the API for one concrete reason: parsing 2.4 million stop times
 * out of a 300 MB archive peaks at a few hundred megabytes and spends twenty seconds in
 * garbage collection. Inside the API process that shows up as skipped poll cycles at three
 * in the morning -- a strange bug to be handed six weeks later, with nothing in the logs
 * connecting it to a nightly job that appeared to succeed.
 *
 * Run it as a Railway cron service against this same image:
 *
 *     npm run build && npm run static
 *
 * It costs exactly one 511 request, exits when it is finished, and leaves the previous
 * schedule version live if anything fails.
 */

async function main(): Promise<number> {
  console.info(`[static] rebuilding schedule for ${config.profile.agencies.join(', ')}`)

  await warehouse.connect()
  if (!warehouse.available()) {
    console.error('[static] no warehouse; nothing to do')
    return 1
  }

  const result = await rebuildSchedule()
  if (!result) {
    // The previous version is still active and still correct. A failed refresh means
    // yesterday's schedule, which for a timetable that changes a few times a year is very
    // nearly as good as today's.
    console.error('[static] rebuild produced nothing; the previous version stays live')
    return 1
  }

  await warehouse.rollPartitions(warehouse.today())

  console.info(
    `[static] done: version ${result.feedVersion}, ${result.trips} trips, ` +
      `${result.stopTimes} stop times, ${result.serviceDays} service days in ` +
      `${result.seconds.toFixed(1)}s`,
  )
  return result.outOfOrderTrips > 0 ? 1 : 0
}

const code = await main().catch((err) => {
  console.error('[static] failed:', (err as Error).message)
  return 1
})

await warehouse.close()
await redis.quit().catch(() => undefined)
process.exit(code)
