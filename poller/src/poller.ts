import { randomUUID } from 'node:crypto'
import { startAccuracy, stopAccuracy } from './accuracy.js'
import { config } from './config.js'
import { redis } from './redis.js'
import { fetchUpstream, fetchUpstreamProtobuf } from './upstream.js'
import { NoKeyAvailableError, BudgetUnavailableError } from './keypool.js'
import { groupByStop, type SIRIResponse } from './siri.js'
import { writeSnapshot, writeVehicles, rememberAgency } from './snapshot.js'
import { groupTripUpdates, decodeVehiclePositions } from './gtfsrt.js'
import {
  loadStaticGTFS,
  loadTripTable,
  loadStopTable,
  loadBartGeometry,
  staticTablesMissing,
  staticRefreshIntervalMs,
} from './gtfs.js'
import {
  fetchBartEtd,
  bartAvailable,
  recordBartSuccess,
  recordBartFailure,
  type BartEtd,
} from './bart.js'
import { enrichWithEtd } from './bartetd.js'
import { synthesizeBartVehicles } from './bartposition.js'
import type { VehicleRecord } from './gtfsrt.js'
import { decodeTripUpdates, decodeVehicles, countSchedulePassthrough, mergeSurvey, surveyToJSON, type FeedSurvey } from './rtdecode.js'
import { TripTracker } from './observe.js'
import { DeviationTracker } from './deviation.js'
import { DriftTracker } from './drift.js'
import { localDate } from './servicedate.js'
import * as eventlog from './eventlog.js'
import * as scheduleIndex from './scheduleindex.js'
import { startLearner, stopLearner } from './learner.js'
import * as agencyerror from './agencyerror.js'
import { writeIndex } from './predictions.js'
import * as warehouse from './warehouse.js'
import { publishFeeds, publishSynthVehicles, reportBridgeFailure } from './bridge.js'

/** Keeps every agency's departures current, on a schedule of our choosing. */

/** Identifies this process in the leader lock. */
const instanceId = randomUUID()

/**
 * The learner shares this lease rather than electing separately.
 *
 * Two elections could land on two different instances, and two learners doing
 * read-modify-write on the same profile cells double-count with no symptom at all -- every
 * cell simply shrinks less than it should, everywhere, forever.
 */
export function pollerInstanceId(): string {
  return instanceId
}

const LEADER_KEY = 'poller:leader'

let timer: NodeJS.Timeout | null = null
let staticTimer: NodeJS.Timeout | null = null
let cursor = 0
/** Guards against a slow cycle overlapping the next tick. */
let inFlight = false

/** Null means "publish every operator the regional feed carries". */
function agencySet(): Set<string> | null {
  return config.poll.allAgencies ? null : new Set(config.poll.agencies)
}

/** The five operators whose history is learned, which is a much shorter list. */
function profiledSet(): Set<string> {
  return new Set(config.profile.agencies)
}

/** Running totals of what the feed actually contains, for /health and the forensics report. */
const survey: FeedSurvey = new Map()

export function feedSurvey(): ReturnType<typeof surveyToJSON> {
  return surveyToJSON(survey)
}

/**
 * The observation pipeline.
 *
 * Deliberately built once and kept: the tracker's whole job is remembering what the feed
 * said last cycle, so it cannot be reconstructed per tick.
 */
const tripTracker = new TripTracker({ profiled: profiledSet() })
const deviationTracker = new DeviationTracker()

/**
 * Unscoped, unlike the two above.
 *
 * It follows every stop in the regional feed rather than the profiled agencies' stops,
 * because measuring how a producer's own estimate converges needs nothing from the
 * schedule and therefore costs nothing per extra agency.
 */
const driftTracker = new DriftTracker()

/** How often the learned drift view is rebuilt from Postgres for the prediction path. */
const AGENCY_ERROR_REFRESH_SECONDS = 300
let agencyErrorLoadedAt = 0

export function observationStats() {
  return { tracker: tripTracker.stats, deviation: deviationTracker.stats, activeTrips: tripTracker.activeTrips }
}

export function driftStats() {
  return driftTracker.status()
}

/** Claims (or renews) the right to poll. */
async function isLeader(leaseMs: number): Promise<boolean> {
  try {
    const acquired = await redis.set(LEADER_KEY, instanceId, 'PX', leaseMs, 'NX')
    if (acquired === 'OK') return true

    const holder = await redis.get(LEADER_KEY)
    if (holder !== instanceId) return false

    await redis.pexpire(LEADER_KEY, leaseMs)
    return true
  } catch (err) {
    // Without Redis we can neither coordinate nor store what we'd fetch, so polling
    // while it's down would spend the budget on data with nowhere to go.
    console.error('[poller] leader check failed:', (err as Error).message)
    return false
  }
}

/** Classifies a failure as "expected, be quiet" or "unexpected, say so". */
function reportPollFailure(what: string, err: unknown): void {
  if (err instanceof NoKeyAvailableError) {
    console.warn(`[poller] skipping ${what}: hourly budget exhausted`)
  } else if (err instanceof BudgetUnavailableError) {
    console.warn(`[poller] skipping ${what}: ${(err as Error).message}`)
  } else {
    console.error(`[poller] ${what} failed:`, (err as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Regional GTFS-RT (the default)
// ---------------------------------------------------------------------------

/** One regional cycle: fetch, join against the static tables, store. */
async function pollRegional(): Promise<void> {
  const startedAt = Date.now()

  // The names live here. Without them we'd publish departures labelled with raw ids,
  // which is worse than briefly publishing nothing.
  if (await staticTablesMissing()) {
    console.warn('[poller] static GTFS tables are empty; loading before first sweep')
    await refreshStatic()
    if (await staticTablesMissing()) {
      console.error('[poller] static tables still empty; skipping sweep')
      return
    }
  }

  const [trips, stops] = await Promise.all([loadTripTable(), loadStopTable()])
  const agencies = agencySet()
  const includes = (a: string) => agencies === null || agencies.has(a)
  const wantBart = includes('BA') && bartAvailable()

  // One `allSettled`, so a BART outage is structurally identical to a
  // `vehiclepositions` outage: one rejected entry, one warning, every other feed
  // proceeds untouched. BART's requests cost nothing against the 511 budget.
  const [updates, vehicles, etd] = await Promise.allSettled([
    fetchUpstreamProtobuf('tripupdates', { agency: 'RG' }),
    config.poll.vehicles
      ? fetchUpstreamProtobuf('vehiclepositions', { agency: 'RG' })
      : Promise.resolve(null),
    wantBart && etdDue() ? fetchBartEtd() : Promise.resolve(null),
  ])

  if (etd.status === 'rejected') {
    recordBartFailure()
    reportPollFailure('BART etd', etd.reason)
  } else if (etd.value) {
    recordBartSuccess()
    lastEtdAt = Date.now()
    lastEtd = etd.value
  }

  /**
   * The most recent ETD, not only one fetched this cycle.
   *
   * Snapshots are rewritten in full every cycle, so enriching only on fetch cycles
   * would publish platform numbers and car counts half the time and drop them the
   * other half — a board that flickers between two levels of detail. Reusing the last
   * response is sound because every estimate is relative to its own `fetchedAt`, so a
   * 15-second-old ETD still yields the same absolute times.
   */
  const etdValue: BartEtd | null =
    lastEtd && Date.now() - lastEtdAt <= config.bart.etdIntervalSeconds * 2000
      ? lastEtd
      : null

  // --- bridge --------------------------------------------------------------
  // Republished first, and unmodified, so headways sees this cycle's bytes at the same
  // moment we do rather than after the work below. Its own try/catch for the usual
  // reason: a Redis hiccup on the bridge costs the map fifteen seconds of freshness and
  // must never cost the other twenty-three operators their snapshot.
  if (config.bridge.enabled) {
    try {
      await publishFeeds(
        vehicles.status === 'fulfilled' ? vehicles.value : null,
        updates.status === 'fulfilled' ? updates.value : null,
        new Date(startedAt),
      )
    } catch (err) {
      reportBridgeFailure('publishFeeds', err)
    }
  }

  // Vehicles from every source are collected and written once, so that a failure in
  // one source never clears the other's agencies.
  const records: VehicleRecord[] = []

  // --- departures ----------------------------------------------------------
  if (updates.status === 'rejected') {
    reportPollFailure('regional tripupdates', updates.reason)
  } else {
    try {
      const grouped = groupTripUpdates(updates.value, trips, stops, agencies)
      let storedStops = 0

      // Enrich BART before storing: platform, car count, delay and the "Leaving"
      // clamp have to be on the visits by the time they reach Redis.
      if (etdValue) {
        try {
          const tables = await loadBartGeometry()
          const byStop = grouped.byAgency.get('BA')
          if (byStop) {
            const s = enrichWithEtd(byStop, etdValue, tables)
            console.info(
              `[poller] BART etd: matched ${s.matched}/${s.estimates} estimates` +
                (s.leavingClamped > 0 ? `, ${s.leavingClamped} leaving` : ''),
            )
          }
        } catch (err) {
          console.error('[poller] BART etd enrichment failed:', (err as Error).message)
        }
      }

      // Iterating what the feed produced rather than what configuration expects. An
      // agency absent from this cycle keeps its previous snapshot, which is right
      // overnight when operators genuinely stop reporting and is also the safe answer if
      // 511 drops one mid-feed.
      for (const [agency, byStop] of grouped.byAgency) {
        if (byStop.size === 0) continue
        storedStops += await writeSnapshot(agency, {
          byStop,
          responseTimestamp: grouped.responseTimestamp,
          dropped: 0,
        })
        await rememberAgency(agency)
      }

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
      console.info(
        `[poller] regional: ${grouped.totalVisits} visits across ${storedStops} stops ` +
          `in ${seconds}s` +
          (grouped.unmatchedTrips > 0
            ? ` (${grouped.unmatchedTrips} trips not in the static table)`
            : ''),
      )

      // A feed that decodes but matches nothing means the static tables and the live
      // feed have drifted apart — usually a service change we haven't mirrored yet.
      if (grouped.totalVisits > 0 && grouped.unmatchedTrips > grouped.totalVisits / 2) {
        console.warn(
          '[poller] most trips are missing from the static table; consider forcing a ' +
            'static refresh (the archive may have moved on)',
        )
      }
    } catch (err) {
      console.error('[poller] regional index/store failed:', (err as Error).message)
    }
  }

  // --- vehicles ------------------------------------------------------------
  if (vehicles.status === 'rejected') {
    reportPollFailure('regional vehiclepositions', vehicles.reason)
  } else if (vehicles.value) {
    try {
      records.push(...decodeVehiclePositions(vehicles.value, trips, stops, agencies))
    } catch (err) {
      console.error('[poller] vehicle decode failed:', (err as Error).message)
    }
  }

  // --- BART positions ------------------------------------------------------
  // BART publishes none, so its trains are placed by interpolating along the track
  // from the very same trip updates that produced the board above. Its own try/catch:
  // a throw in the geometry must never cost the other 23 operators their snapshot.
  if (
    config.bart.synthesizeVehicles &&
    includes('BA') &&
    updates.status === 'fulfilled'
  ) {
    try {
      const tables = await loadBartGeometry()
      if (tables.shapes.size === 0) {
        console.warn('[poller] no BART shapes loaded; skipping position synthesis')
      } else {
        const { vehicles: bartVehicles, stats } = synthesizeBartVehicles(
          updates.value,
          trips,
          stops,
          tables,
        )
        records.push(...bartVehicles)
        if (config.bridge.enabled) {
          await publishSynthVehicles(bartVehicles, new Date(startedAt)).catch((err) =>
            reportBridgeFailure('publishSynthVehicles', err),
          )
        }
        console.info(
          `[poller] BART positions: ${stats.placed}/${stats.trips} placed ` +
            `(${stats.atStation} at a station)` +
            (stats.dropped > 0 ? `, ${stats.dropped} dropped` : ''),
        )
        // Both are impossible if the arithmetic is right, so either one is a bug.
        if (stats.implausibleSpeed > 0 || stats.implausibleOffset > 0) {
          console.error(
            `[poller] BART position canary tripped: ${stats.implausibleSpeed} over 35 m/s, ` +
              `${stats.implausibleOffset} more than 200 m off track`,
          )
        }
        lastSynthesisStats = stats
      }
    } catch (err) {
      console.error('[poller] BART position synthesis failed:', (err as Error).message)
    }
  }

  if (records.length > 0) {
    try {
      await writeVehicles(records)
    } catch (err) {
      console.error('[poller] vehicle store failed:', (err as Error).message)
    }
  }

  // --- prediction drift ----------------------------------------------------
  // Separate from observation below, and deliberately not inside it: `observeCycle`
  // returns early without a schedule and filters to the five profiled agencies, and this
  // measurement needs neither. It reads the trip-update stream alone, so every operator
  // the regional feed carries is measured — which is the entire point, since the map shows
  // all of them and the segment profile can only ever afford a handful.
  if (config.profile.enabled && updates.status === 'fulfilled') {
    try {
      await driftCycle(updates.value, Math.floor(startedAt / 1000))
    } catch (err) {
      console.error('[poller] drift failed:', (err as Error).message)
    }
  }

  // --- observation ---------------------------------------------------------
  // Its own try/catch, exactly like BART geometry above and for the same reason: the
  // historical system is an enhancement, and a throw in it must never cost the other
  // twenty-three operators their snapshot. Everything below this line can be deleted and
  // the departures feed is unchanged.
  if (config.profile.enabled && updates.status === 'fulfilled') {
    try {
      await observeCycle(
        updates.value,
        vehicles.status === 'fulfilled' ? vehicles.value : null,
        Math.floor(startedAt / 1000),
      )
    } catch (err) {
      console.error('[poller] observation failed:', (err as Error).message)
    }
  }
}

/**
 * Turns this cycle's feed into observations.
 *
 * Decoded a second time, from `rtdecode.ts` rather than from the SIRI translation above.
 * That duplication is the **learning firewall** and it is worth its cost: the model trains
 * on what the agency published, never on anything this service has shaped, filtered or
 * corrected. A learner fed its own output drifts into agreeing with itself, and the
 * symptom -- a model that scores beautifully and predicts badly -- is among the hardest
 * kinds of wrong to notice.
 */
/**
 * Measures how each agency's own predictions move as arrivals close.
 *
 * The `null` agency filter is the whole design decision. Everything else in the learning
 * path is scoped to `PROFILED_AGENCIES`, because a stop-level observation costs schedule
 * rows and profile cells per agency and there is no point paying that for an operator
 * nobody asked about. This costs neither -- it needs no schedule at all -- so it is scoped
 * to nothing and covers every operator in the feed.
 *
 * The service date is approximated by shifting three hours back rather than resolved
 * against the calendar, because resolving it properly would reintroduce the schedule
 * dependency this measurement exists without. The shift is the standard transit
 * convention and puts owl trips on the day they belong to; the cost is that a genuine
 * 03:00 boundary case lands in a neighbouring three-hour period, which is well inside the
 * resolution this model claims.
 */
async function driftCycle(tripBuffer: Uint8Array, at: number): Promise<void> {
  const { updates } = decodeTripUpdates(tripBuffer, null)
  const serviceDate = localDate((at - 3 * 3600) * 1000)
  const samples = driftTracker.ingest(updates, at, serviceDate)
  if (samples.length === 0) return
  await warehouse.foldDrift(samples)

  // Rebuilt on a timer rather than after every fold: the prediction path reads this view,
  // and rebuilding it mid-cycle would put a full table scan on the path of a response.
  if (at - agencyErrorLoadedAt >= AGENCY_ERROR_REFRESH_SECONDS) {
    agencyErrorLoadedAt = at
    void agencyerror.refresh()
  }
}

async function observeCycle(
  tripBuffer: Uint8Array,
  vehicleBuffer: Uint8Array | null,
  at: number,
): Promise<void> {
  const profiled = profiledSet()
  if (profiled.size === 0) return

  const schedule = await scheduleIndex.refresh()
  if (schedule.size === 0) return

  const cycleSurvey: FeedSurvey = new Map()
  const { updates } = decodeTripUpdates(tripBuffer, profiled, cycleSurvey)
  const { vehicles } = vehicleBuffer
    ? decodeVehicles(vehicleBuffer, profiled, cycleSurvey)
    : { vehicles: [] }

  // A producer with nothing live to say often republishes the timetable rather than going
  // quiet, and the result is indistinguishable from a prediction unless somebody looks.
  countSchedulePassthrough(updates, scheduleIndex.scheduledAt, cycleSurvey)
  mergeSurvey(survey, cycleSurvey)

  // The parallel index /v1/predictions reads. Written here rather than folded into the
  // departures snapshot so that the one response the app depends on keeps its exact bytes.
  const byAgency = new Map<string, typeof updates>()
  for (const u of updates) {
    const agency = u.tripId.slice(0, u.tripId.indexOf(':'))
    if (!agency) continue
    const list = byAgency.get(agency)
    if (list) list.push(u)
    else byAgency.set(agency, [u])
  }
  for (const [agency, list] of byAgency) await writeIndex(agency, list)

  const events = tripTracker.ingest({ at, updates, vehicles }, schedule, scheduleIndex.resolveServiceDate)
  if (events.length === 0) return

  const deviations = []
  for (const event of events) {
    const d = deviationTracker.from(event, schedule, config.profile.holdOffsetSeconds)
    if (d) deviations.push(d)
  }

  deviationTracker.prune(at)
  await eventlog.append(deviations)
}

// ETD moves slower than positions do, so it is fetched on its own cadence rather than
// every cycle.
let lastEtdAt = 0
let lastEtd: BartEtd | null = null
let lastSynthesisStats: import('./bartposition.js').SynthesisStats | null = null

function etdDue(): boolean {
  return Date.now() - lastEtdAt >= config.bart.etdIntervalSeconds * 1000
}

/** BART synthesis counters, for `/health`. */
export function bartSynthesisStatus(): import('./bartposition.js').SynthesisStats | null {
  return lastSynthesisStats
}

// ---------------------------------------------------------------------------
// Per-agency SIRI (fallback)
// ---------------------------------------------------------------------------

/** One agency-wide SIRI fetch, indexed and stored. */
async function pollAgencySIRI(agency: string): Promise<void> {
  const startedAt = Date.now()

  let response: SIRIResponse
  try {
    // No `stopcode` — this is the whole agency in one request.
    response = await fetchUpstream<SIRIResponse>('StopMonitoring', { agency })
  } catch (err) {
    reportPollFailure(agency, err)
    return
  }

  try {
    const grouped = groupByStop(response)
    const stops = await writeSnapshot(agency, grouped)
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)

    if (stops === 0) {
      console.warn(
        `[poller] ${agency}: feed returned no stops in ${seconds}s, keeping previous snapshot`,
      )
      return
    }
    console.info(
      `[poller] ${agency}: ${stops} stops in ${seconds}s` +
        (grouped.dropped > 0 ? ` (${grouped.dropped} visits had no stop ref)` : ''),
    )
  } catch (err) {
    console.error(`[poller] ${agency} index/store failed:`, (err as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

/** Rebuilds the trip and stop tables from the regional archive. */
async function refreshStatic(): Promise<void> {
  const startedAt = Date.now()
  try {
    const { trips, stops } = await loadStaticGTFS()
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.info(`[poller] static GTFS: ${trips} trips, ${stops} stops in ${seconds}s`)
  } catch (err) {
    reportPollFailure('static GTFS refresh', err)
    console.warn('[poller] keeping the previous static tables')
  }
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Milliseconds between ticks. In `siri` mode a tick is one agency, not one sweep. */
function stepMs(): number {
  const interval = config.poll.intervalSeconds * 1000
  if (config.poll.mode === 'siri') {
    // Staggered rather than bursted: eight simultaneous agency-wide downloads would
    // spike memory and hand 511 a thundering herd every interval.
    return Math.max(1000, Math.round(interval / Math.max(1, config.poll.agencies.length)))
  }
  return Math.max(1000, interval)
}

async function step(): Promise<void> {
  // A cycle that overran its interval must not have a second one pile up behind it —
  // that way lies two in-flight regional fetches and double the budget spend.
  if (inFlight) {
    console.warn('[poller] previous cycle still running; skipping this tick')
    return
  }
  if (!(await isLeader(stepMs() * 3))) return

  inFlight = true
  try {
    if (config.poll.mode === 'siri') {
      const agencies = config.poll.agencies
      if (agencies.length === 0) return
      const agency = agencies[cursor % agencies.length]
      cursor = (cursor + 1) % agencies.length
      await pollAgencySIRI(agency)
    } else {
      await pollRegional()
    }
  } finally {
    inFlight = false
  }
}

/** Requests per hour this configuration will spend on polling alone. */
/**
 * Requests per hour this configuration spends on polling alone.
 *
 * In `rg` mode the answer does not depend on how many agencies are published, which is the
 * whole point. In `siri` mode it is one request per agency per cycle -- and with the
 * default `POLLED_AGENCIES=*` there is no list to count, so the escape hatch is costed
 * against the number of operators the regional feed actually carries. At two dozen
 * operators that is thousands of requests an hour against a budget of six hundred: `siri`
 * is no longer a drop-in fallback, it is "poll a named subset", and the guard below says so
 * rather than leaving it to be discovered.
 */
const REGIONAL_OPERATORS = 24

function sweepCostPerHour(): number {
  const cycles = 3600 / config.poll.intervalSeconds
  if (config.poll.mode === 'siri') {
    const agencies = config.poll.allAgencies
      ? REGIONAL_OPERATORS
      : config.poll.agencies.length
    return Math.round(agencies * cycles)
  }
  return Math.round((config.poll.vehicles ? 2 : 1) * cycles)
}

export function startPoller(): void {
  if (!config.poll.enabled) {
    console.info('[poller] disabled by configuration; departures will be fetched on demand')
    return
  }
  if (config.poll.agencies.length === 0 && !config.poll.allAgencies) {
    console.warn('[poller] no agencies configured; nothing to poll')
    return
  }

  const perHour = sweepCostPerHour()
  const budget = config.fiveEleven.keys.length * config.fiveEleven.hourlyLimitPerKey

  if (config.poll.mode === 'siri') {
    console.info(
      `[poller] SIRI mode: sweeping ${config.poll.agencies.length} agencies every ` +
        `${config.poll.intervalSeconds}s = ~${perHour}/hour of ${budget}`,
    )
  } else {
    const covering = config.poll.allAgencies
      ? 'every operator in the feed'
      : `${config.poll.agencies.length} agencies`
    console.info(
      `[poller] regional mode: ${config.poll.vehicles ? 2 : 1} request(s) every ` +
        `${config.poll.intervalSeconds}s covering ${covering} = ~${perHour}/hour of ${budget}`,
    )
  }

  if (config.bart.enabled && (config.poll.allAgencies || config.poll.agencies.includes('BA'))) {
    // Said explicitly so nobody later "fixes" sweepCostPerHour() to include these.
    console.info(
      `[poller] BART: etd every ${config.bart.etdIntervalSeconds}s, positions every ` +
        `${config.poll.intervalSeconds}s — free, not against the 511 budget`,
    )
  }

  if (perHour > budget) {
    console.error(
      `[poller] CONFIGURATION ERROR: polling alone needs ${perHour} requests/hour but the ` +
        `key pool only allows ${budget}. Raise POLL_INTERVAL_SECONDS, add keys, or raise ` +
        `FIVEELEVEN_HOURLY_LIMIT if 511 granted an increase.` +
        (config.poll.mode === 'siri'
          ? ` In siri mode the cost is one request per agency per cycle, so set ` +
            `POLLED_AGENCIES to a named subset rather than '*'.`
          : ''),
    )
  } else if (perHour > budget * 0.9) {
    console.warn(
      `[poller] polling uses ${perHour} of ${budget} requests/hour, leaving little room for ` +
        `reference data or the daily archive.`,
    )
  }

  // First cycle immediately so a cold deploy starts filling the snapshot at once
  // rather than after a full interval of silence.
  void step()
  timer = setInterval(() => void step(), stepMs())

  if (config.profile.enabled) {
    // Bound to this instance's lease, so a replica that is not polling also does not learn.
    startLearner(instanceId)
    startAccuracy(() => isLeader(stepMs() * 3))
    void warehouse.connect().then(() => scheduleIndex.refresh(true))
  }

  if (config.poll.mode === 'rg') {
    // The first static load is handled by `pollRegional` when it finds the tables
    // empty, so this only needs to schedule the recurring refresh.
    staticTimer = setInterval(() => {
      void (async () => {
        if (await isLeader(stepMs() * 3)) await refreshStatic()
      })()
    }, staticRefreshIntervalMs())
    console.info(
      `[poller] static GTFS refresh every ${config.poll.staticRefreshHours}h (1 request)`,
    )
  }
}

export async function stopPoller(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null }
  if (staticTimer) { clearInterval(staticTimer); staticTimer = null }
  stopAccuracy()
  await stopLearner()
  await warehouse.close()
  // Release the lock on a clean shutdown so a redeploy's replacement can start
  // polling immediately instead of waiting out our lease.
  try {
    const holder = await redis.get(LEADER_KEY)
    if (holder === instanceId) await redis.del(LEADER_KEY)
  } catch {
    // The lease expires on its own; nothing to do.
  }
}
