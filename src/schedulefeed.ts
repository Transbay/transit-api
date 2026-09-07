import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { config } from './config.js'
import { fetchUpstreamRaw } from './upstream.js'
import { readCSVPositional, trimTrailingBytes } from './gtfs.js'
import { patternHash, timepointsAreInformative, type ScheduledStop, type TripSchedule } from './schedule.js'
import { parseGtfsTime, shiftDate, localDate, type ServiceDate } from './servicedate.js'
import {
  beginFeedVersion,
  saveTrips,
  saveServiceDays,
  activateFeedVersion,
  available as warehouseAvailable,
} from './warehouse.js'

/**
 * Building the schedule the delay profile measures against.
 *
 * `gtfs.ts` reads three small files out of the 300 MB regional archive and skips
 * `stop_times.txt` entirely, which is exactly right for its job — names do not need
 * scheduled times. Deviation does: without a scheduled time there is nothing to deviate
 * from, and `stop_times.txt` is 285 MB of the archive.
 *
 * Two things make that affordable:
 *
 * - **The prefilter.** `trip_id` is the first column and is agency-qualified, so five
 *   agencies' worth of rows are recognised before the line is split. Roughly 2.4 million
 *   rows survive out of about four million.
 * - **Emit on trip change.** GTFS orders `stop_times.txt` by trip, so one trip's stops can
 *   be assembled, written and released before the next begins. Buffering all 2.4 million
 *   rows as objects first would hold well over a gigabyte and take the container with it.
 *
 * This runs as its own process (`index.static.ts`), on its own schedule. The peak of the
 * parse is a few hundred megabytes and the garbage collection that goes with it is
 * seconds long — inside the API process that would show up as skipped poll cycles at three
 * in the morning, which is a strange bug to debug six weeks later.
 */

/** How many days either side of today to expand the calendar for. */
const CALENDAR_WINDOW_DAYS = 21

export interface ScheduleBuildResult {
  feedVersion: number
  trips: number
  stopTimes: number
  serviceDays: number
  skippedTrips: number
  outOfOrderTrips: number
  seconds: number
}

interface RawTrip {
  routeId: string
  directionId: number
  serviceId: string
  blockId: string
  shortName: string
}

/**
 * Downloads the regional archive and rebuilds the profiled agencies' schedule.
 *
 * The *regional* archive, not five per-agency ones, and that is a deliberate trade. Fetching
 * per agency would be five requests instead of one and would stop a Muni service change
 * invalidating BART's tables — but the regional archive's ids (`SF:12345`) are the ones the
 * regional realtime feed uses, and a per-agency archive publishes them bare. Matching a live
 * trip to its schedule matters more than isolating the versions, and `warehouse.ts` keeps
 * three versions live to soften the changeover anyway.
 */
export async function rebuildSchedule(): Promise<ScheduleBuildResult | null> {
  if (!warehouseAvailable()) {
    console.warn('[schedule] no warehouse; skipping schedule build')
    return null
  }

  const agencies = config.profile.agencies
  if (agencies.length === 0) {
    console.warn('[schedule] no profiled agencies configured')
    return null
  }

  const startedAt = Date.now()
  const prefixes = agencies.map((a) => `${a}:`)
  const dir = await mkdtemp(join(tmpdir(), 'transitapi-gtfs-'))
  const zipPath = join(dir, 'regional.zip')

  try {
    const body = await fetchUpstreamRaw('datafeeds', { operator_id: 'RG' })
    await pipeline(Readable.fromWeb(body as never), createWriteStream(zipPath))
    await trimTrailingBytes(zipPath)

    const feedVersion = await beginFeedVersion(agencies)
    if (feedVersion === null) {
      console.error('[schedule] could not open a feed version; aborting')
      return null
    }

    // --- trips ------------------------------------------------------------
    const trips = new Map<string, RawTrip>()
    await readCSVPositional(
      zipPath,
      'trips.txt',
      ['trip_id', 'route_id', 'direction_id', 'service_id', 'block_id', 'trip_short_name'],
      (cells, i) => {
        const tripId = cells[i('trip_id')] ?? ''
        if (!prefixes.some((p) => tripId.startsWith(p))) return
        trips.set(tripId, {
          routeId: cells[i('route_id')] ?? '',
          directionId: cells[i('direction_id')] === '1' ? 1 : 0,
          serviceId: cells[i('service_id')] ?? '',
          blockId: (cells[i('block_id')] ?? '').trim(),
          shortName: (cells[i('trip_short_name')] ?? '').trim(),
        })
      },
    )
    console.info(`[schedule] ${trips.size} trips across ${agencies.join(', ')}`)

    // --- stop times -------------------------------------------------------
    let written = 0
    let stopTimes = 0
    let skipped = 0
    let outOfOrder = 0

    let currentId = ''
    let currentStops: ScheduledStop[] = []
    const emitted = new Set<string>()
    let batch: TripSchedule[] = []

    const flush = async () => {
      if (batch.length === 0) return
      written += await saveTrips(feedVersion, batch)
      batch = []
    }

    /** Batch size: big enough that the round trips disappear, small enough to stay flat. */
    const BATCH = 500

    const finishTrip = () => {
      if (!currentId || currentStops.length < 2) {
        // A one-stop trip has no segments and nothing to say about running time.
        if (currentId) skipped++
        return
      }
      const raw = trips.get(currentId)
      if (!raw) {
        skipped++
        return
      }
      currentStops.sort((a, b) => a.seq - b.seq)
      batch.push({
        agency: currentId.slice(0, currentId.indexOf(':')),
        tripId: currentId,
        routeId: raw.routeId,
        directionId: raw.directionId,
        patternId: patternHash(currentStops.map((s) => s.stopId)),
        serviceId: raw.serviceId,
        blockId: raw.blockId,
        shortName: raw.shortName,
        stops: currentStops,
        timepointsInformative: timepointsAreInformative(currentStops),
      })
      emitted.add(currentId)
    }

    await readCSVPositional(
      zipPath,
      'stop_times.txt',
      ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'timepoint'],
      (cells, i): void | Promise<void> => {
        const tripId = cells[i('trip_id')] ?? ''
        if (!trips.has(tripId)) return

        if (tripId !== currentId) {
          finishTrip()

          if (emitted.has(tripId)) {
            // GTFS orders this file by trip in every real feed, and the whole streaming
            // design rests on that. If it ever stops being true the trip is dropped rather
            // than half-written, and the count says so loudly enough to notice.
            outOfOrder++
            currentId = ''
            currentStops = []
            return
          }

          currentId = tripId
          currentStops = []

          // The whole point of emitting on trip change: at most one batch of assembled
          // trips is ever resident, so the parse stays flat in memory however large the
          // feed gets. Buffering all forty-eight thousand and writing at the end would
          // hold well over a gigabyte and take the container with it.
          if (batch.length >= BATCH) return flush()
        }

        const arrival = parseGtfsTime(cells[i('arrival_time')] ?? '')
        const departure = parseGtfsTime(cells[i('departure_time')] ?? '')
        if (arrival === null && departure === null) return

        const seq = Number(cells[i('stop_sequence')] ?? '')
        if (!Number.isFinite(seq)) return

        currentStops.push({
          stopId: cells[i('stop_id')] ?? '',
          seq,
          arrival: arrival ?? departure!,
          departure: departure ?? arrival!,
          // Absent means "approximate" in the spec, but in practice a producer that omits
          // the column holds at nothing rather than everything, and assuming otherwise
          // would put a hold on every stop in the network.
          timepoint: (cells[i('timepoint')] ?? '') === '1',
        })
        stopTimes++
      },
      { prefilter: (line) => prefixes.some((p) => line.startsWith(p)), firstColumn: 'trip_id' },
    )
    finishTrip()
    await flush()

    if (outOfOrder > 0) {
      console.error(
        `[schedule] ${outOfOrder} trips appeared out of order in stop_times.txt and were ` +
          `dropped; the streaming parse assumes trip-contiguous ordering`,
      )
    }

    // --- calendar ---------------------------------------------------------
    const serviceDays = await buildCalendar(zipPath, feedVersion, prefixes, trips)

    await activateFeedVersion(feedVersion)

    const seconds = (Date.now() - startedAt) / 1000
    console.info(
      `[schedule] version ${feedVersion}: ${written} trips, ${stopTimes} stop times, ` +
        `${serviceDays} service days in ${seconds.toFixed(1)}s` +
        (skipped > 0 ? ` (${skipped} trips skipped)` : ''),
    )

    return {
      feedVersion,
      trips: written,
      stopTimes,
      serviceDays,
      skippedTrips: skipped,
      outOfOrderTrips: outOfOrder,
      seconds,
    }
  } finally {
    // The archive is 300 MB; a container that leaks one a night fills its disk in a week.
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Expands `calendar.txt` and `calendar_dates.txt` into concrete dates.
 *
 * Both files, and in that order: `calendar.txt` gives the weekly pattern and its date
 * range, `calendar_dates.txt` adds and removes individual days on top. The exceptions are
 * not a footnote — they are how every holiday in the feed is expressed, and a service
 * calendar built from the weekly pattern alone runs a full weekday timetable on Christmas
 * morning.
 */
async function buildCalendar(
  zipPath: string,
  feedVersion: number,
  prefixes: string[],
  trips: Map<string, RawTrip>,
): Promise<number> {
  const wanted = new Map<string, string>()
  for (const [tripId, t] of trips) {
    if (t.serviceId) wanted.set(t.serviceId, tripId.slice(0, tripId.indexOf(':')))
  }
  if (wanted.size === 0) return 0

  const today = localDate(Date.now())
  const window: ServiceDate[] = []
  for (let d = -CALENDAR_WINDOW_DAYS; d <= CALENDAR_WINDOW_DAYS; d++) {
    window.push(shiftDate(today, d))
  }
  const compact = new Map(window.map((d) => [d.replace(/-/g, ''), d]))

  const active = new Map<string, Set<string>>()
  const add = (serviceId: string, day: string) => {
    let set = active.get(serviceId)
    if (!set) active.set(serviceId, (set = new Set()))
    set.add(day)
  }

  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

  await readCSVPositional(
    zipPath,
    'calendar.txt',
    ['service_id', 'start_date', 'end_date', ...DAYS],
    (cells, i) => {
      const serviceId = cells[i('service_id')] ?? ''
      if (!wanted.has(serviceId)) return
      const start = cells[i('start_date')] ?? ''
      const end = cells[i('end_date')] ?? ''
      for (const [compactDay, day] of compact) {
        if (compactDay < start || compactDay > end) continue
        const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
        if ((cells[i(DAYS[weekday])] ?? '') === '1') add(serviceId, day)
      }
    },
  ).catch((err) => {
    // A feed may express its whole calendar in exceptions and ship no `calendar.txt` at
    // all, which is legal. Missing is fine; failing is not.
    console.warn('[schedule] calendar.txt unavailable:', (err as Error).message)
    return 0
  })

  await readCSVPositional(
    zipPath,
    'calendar_dates.txt',
    ['service_id', 'date', 'exception_type'],
    (cells, i) => {
      const serviceId = cells[i('service_id')] ?? ''
      if (!wanted.has(serviceId)) return
      const day = compact.get(cells[i('date')] ?? '')
      if (!day) return
      if ((cells[i('exception_type')] ?? '') === '1') add(serviceId, day)
      else active.get(serviceId)?.delete(day)
    },
  ).catch((err) => {
    console.warn('[schedule] calendar_dates.txt unavailable:', (err as Error).message)
    return 0
  })

  const rows: { agency: string; serviceId: string; day: string }[] = []
  for (const [serviceId, days] of active) {
    const agency = wanted.get(serviceId) ?? ''
    for (const day of days) rows.push({ agency, serviceId, day })
  }
  return saveServiceDays(feedVersion, rows)
}
