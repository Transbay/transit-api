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
  /** Trips whose declared start_date did not explain when they were running. */
  declaredDateOverridden: 0,
  /** Trips no candidate service date explained at all. */
  unexplainedTrips: 0,
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
 * A service day is not a calendar day: the 00:25 owl bus belongs to *yesterday's* schedule,
 * and GTFS says so by letting its stop times run past 24:00:00.
 *
 * The obvious implementation is to trust `start_date` on the trip descriptor, and that is
 * what this did. **It is wrong, and measurably so.** Muni publishes `start_date` as the
 * calendar date a trip is running on rather than the service date it belongs to, so every
 * one of its after-midnight trips arrived with a date one day late — and a deviation
 * computed against it is off by exactly 86,400 seconds. Measured on the live feed at 00:25
 * local: 599 of 976 Muni observations were rejected as impossible, which is most of an
 * operator's overnight service, every night.
 *
 * So `start_date` is a strong hint rather than gospel. The candidate that actually explains
 * when the trip is running wins, and since the candidates are a day apart the comparison is
 * never close: the right one is minutes or hours from the observation, the wrong one is a
 * day. Where the producer's date *is* plausible it is preferred, because it disambiguates
 * cases the arithmetic cannot — a trip whose first stop time is genuinely ambiguous across
 * the repeated hour on a fall-back night, for instance.
 */
export function resolveServiceDate(update: TripUpdateRecord, at: number): string | null {
  const trip = index.trip(update.tripId)
  const declared =
    update.startDate && /^\d{8}$/.test(update.startDate)
      ? `${update.startDate.slice(0, 4)}-${update.startDate.slice(4, 6)}-${update.startDate.slice(6, 8)}`
      : null

  // Without a schedule there is nothing to check the claim against, so take it as given.
  if (!trip) return declared

  const start = update.startTime ? parseGtfsTime(update.startTime) : trip.stops[0]?.departure
  if (start === undefined || start === null) return declared ?? localDate(at * 1000)

  const today = localDate(at * 1000)
  const candidates = [declared, today, shiftDate(today, -1)].filter(
    (d, i, all): d is string => d !== null && all.indexOf(d) === i,
  )

  let best: string | null = null
  let bestGap = Number.POSITIVE_INFINITY
  for (const day of candidates) {
    const gap = Math.abs(epochSecondsFor(day, start) - at)
    if (gap < bestGap) {
      bestGap = gap
      best = day
    }
  }

  // Beyond about eighteen hours, no candidate explains this trip and guessing would put a
  // full day of error into a profile. Better to learn nothing from it.
  if (bestGap > 18 * 3600) {
    scheduleIndexStats.unexplainedTrips++
    return null
  }

  if (declared !== null && best !== declared) {
    // Worth counting rather than silently correcting: a producer that mislabels its
    // overnight service is a fact about the feed, and if this counter is ever zero for an
    // agency that used to have it, something changed upstream.
    scheduleIndexStats.declaredDateOverridden++
  }
  return best
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
