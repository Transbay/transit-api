import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { redis } from './redis.js'
import { fetchUpstream, fetchUpstreamProtobuf } from './upstream.js'
import { NoKeyAvailableError, BudgetUnavailableError } from './keypool.js'
import { groupByStop, type SIRIResponse } from './siri.js'
import { writeSnapshot, writeVehicles } from './snapshot.js'
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

/** Keeps every agency's departures current, on a schedule of our choosing. */

/** Identifies this process in the leader lock. */
const instanceId = randomUUID()

const LEADER_KEY = 'poller:leader'

let timer: NodeJS.Timeout | null = null
let staticTimer: NodeJS.Timeout | null = null
let cursor = 0
/** Guards against a slow cycle overlapping the next tick. */
let inFlight = false

function agencySet(): Set<string> {
  return new Set(config.poll.agencies)
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
  const wantBart = agencies.has('BA') && bartAvailable()

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

      for (const agency of agencies) {
        const byStop = grouped.byAgency.get(agency)
        // An agency absent from this cycle's feed keeps its previous snapshot. That
        // is right overnight, when operators genuinely stop reporting, and it is
        // also the safe answer if 511 drops one mid-feed.
        if (!byStop || byStop.size === 0) continue
        storedStops += await writeSnapshot(agency, {
          byStop,
          responseTimestamp: grouped.responseTimestamp,
          dropped: 0,
        })
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
    agencies.has('BA') &&
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
function sweepCostPerHour(): number {
  const cycles = 3600 / config.poll.intervalSeconds
  if (config.poll.mode === 'siri') return Math.round(config.poll.agencies.length * cycles)
  return Math.round((config.poll.vehicles ? 2 : 1) * cycles)
}

export function startPoller(): void {
  if (!config.poll.enabled) {
    console.info('[poller] disabled by configuration; departures will be fetched on demand')
    return
  }
  if (config.poll.agencies.length === 0) {
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
    console.info(
      `[poller] regional mode: ${config.poll.vehicles ? 2 : 1} request(s) every ` +
        `${config.poll.intervalSeconds}s covering ${config.poll.agencies.length} agencies ` +
        `= ~${perHour}/hour of ${budget}`,
    )
  }

  if (config.bart.enabled && config.poll.agencies.includes('BA')) {
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
        `FIVEELEVEN_HOURLY_LIMIT if 511 granted an increase.`,
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
  // Release the lock on a clean shutdown so a redeploy's replacement can start
  // polling immediately instead of waiting out our lease.
  try {
    const holder = await redis.get(LEADER_KEY)
    if (holder === instanceId) await redis.del(LEADER_KEY)
  } catch {
    // The lease expires on its own; nothing to do.
  }
}
