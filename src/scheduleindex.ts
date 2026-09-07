import { config } from './config.js'
import { ScheduleIndex, type TripSchedule } from './schedule.js'
import {
  localDate,
  shiftDate,
  parseGtfsTime,
  epochSecondsFor,
  dayTypeOf,
  type ServiceDate,
} from './servicedate.js'
import * as warehouse from './warehouse.js'
import type { TripUpdateRecord } from './observe.js'

/**
 * Today's schedule, held in memory, and the rules for deciding which day a live trip
 * belongs to.
 *
 * Rebuilt at the service-day boundary rather than per request: six thousand trips across
 * five agencies is a few megabytes and every lookup afterwards is a `Map.get`. The hot path
 * never queries Postgres, which is what lets predictions keep working while the warehouse
 * is down.
 */

let index = new ScheduleIndex([])
let loadedFor: ServiceDate | null = null
let loadedAt = 0
let holidays = new Map<string, boolean>()

export const scheduleIndexStats = {
  trips: 0,
  loadedFor: null as string | null,
  loadedAt: 0,
  reloads: 0,
  failures: 0,
}

/**
 * Loads the trips for today and yesterday.
 *
 * Yesterday as well as today, always, because at half past midnight the buses still running
 * belong to yesterday's service day and their schedule is in yesterday's calendar. Loading
 * only "today" makes every owl trip unmatchable for the six hours of the night when the
 * data is scarcest and most interesting.
 */
export async function refresh(force = false): Promise<ScheduleIndex> {
  const today = localDate(Date.now())
  if (!force && loadedFor === today && index.size > 0) return index
  if (!warehouse.available()) return index

  const days: ServiceDate[] = [today, shiftDate(today, -1)]
  try {
    const trips = await warehouse.loadTripsFor(config.profile.agencies, days)
    if (trips.length === 0) {
      // An empty result is not a reason to throw away a working index: it usually means the
      // nightly build has not run yet, and yesterday's trips are a far better answer than
      // none while that is true.
      console.warn('[schedule] no trips for today; keeping the previous index')
      return index
    }
    index = new ScheduleIndex(trips)
    loadedFor = today
    loadedAt = Date.now()
    scheduleIndexStats.trips = index.size
    scheduleIndexStats.loadedFor = today
    scheduleIndexStats.loadedAt = loadedAt
    scheduleIndexStats.reloads++

    holidays = new Map()
    await Promise.all(
      config.profile.agencies.map(async (agency) => {
        for (const day of days) {
          holidays.set(`${agency}|${day}`, await warehouse.isHoliday(agency, day))
        }
      }),
    )

    console.info(`[schedule] index for ${today}: ${index.size} trips`)
  } catch (err) {
    scheduleIndexStats.failures++
    console.error('[schedule] index refresh failed:', (err as Error).message)
  }
  return index
}

export function current(): ScheduleIndex {
  return index
}

export function isHoliday(agency: string, day: ServiceDate): boolean {
  return holidays.get(`${agency}|${day}`) ?? false
}

export function dayTypeFor(agency: string, day: ServiceDate) {
  return dayTypeOf(day, isHoliday(agency, day))
}

// ---------------------------------------------------------------------------
// Service dates
// ---------------------------------------------------------------------------

/**
 * Which service day a live trip belongs to.
 *
 * Four ways, in order of how much they can be trusted:
 *
 * 1. The producer said so. `start_date` on the trip descriptor is authoritative and needs
 *    no inference at all.
 * 2. The trip id is in today's index and today's calendar runs it.
 * 3. It is in yesterday's — which is the owl case, and the reason yesterday is loaded.
 * 4. Neither, so there is no schedule to deviate from and the trip is not profiled.
 *
 * Getting this wrong is not subtle in its magnitude — it shifts a deviation by a whole day
 * — but it *is* subtle in its cause, and the plausibility gate in `outlier.ts` catches the
 * result rather than the reason. Which is why the reason is decided here, once.
 */
export function resolveServiceDate(update: TripUpdateRecord, at: number): string | null {
  if (update.startDate && /^\d{8}$/.test(update.startDate)) {
    const d = update.startDate
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
  }

  const trip = index.trip(update.tripId)
  if (!trip) return null

  const today = localDate(at * 1000)
  const yesterday = shiftDate(today, -1)

  // Pick the candidate whose scheduled start is closest to when this trip actually seems to
  // be running. On any ordinary trip today wins by hours; on an owl trip at 00:40 the
  // previous service day wins by the same margin, which is exactly the discrimination
  // needed and the one a naive "use today" gets backwards for six hours a night.
  const start = update.startTime ? parseGtfsTime(update.startTime) : trip.stops[0]?.departure
  if (start === undefined || start === null) return today

  let best: string | null = null
  let bestGap = Number.POSITIVE_INFINITY
  for (const day of [today, yesterday]) {
    const gap = Math.abs(epochSecondsFor(day, start) - at)
    if (gap < bestGap) {
      bestGap = gap
      best = day
    }
  }

  // Beyond about eighteen hours, neither candidate explains this trip and guessing would
  // put a full day of error into a profile.
  return bestGap <= 18 * 3600 ? best : null
}

/** The scheduled epoch time for a stop, used to spot a feed echoing its own timetable. */
export function scheduledAt(tripId: string, stopId: string, seq?: number): number | null {
  const trip = index.trip(tripId)
  if (!trip) return null
  const i = index.positionOf(tripId, stopId, seq)
  if (i < 0) return null
  const day = loadedFor ?? localDate(Date.now())
  return epochSecondsFor(day, trip.stops[i].departure)
}

export function status() {
  return { ...scheduleIndexStats, ageSeconds: loadedAt ? Math.round((Date.now() - loadedAt) / 1000) : null }
}
