import type { BartEtd, BartEstimate } from './bartparse.js'
import type { BartGeometryTables } from './geo.js'
import type { MonitoredStopVisit } from './siri.js'

// Folding BART's own departure estimates into the SIRI visits built from 511.
//
// The two sources agree closely — measured at a median 22 seconds apart, 99% within 60 —
// so this is not about correcting 511. It is about the four things 511 does not carry at
// all: which platform, how many cars, how late the train is, and BART's authoritative
// "Leaving" flag.

/** Matched within this many seconds. 99% of agreeing pairs are inside 60. */
const MATCH_WINDOW_SECONDS = 90

export interface EtdMatchStats {
  visits: number
  estimates: number
  matched: number
  leavingClamped: number
}

/** Comparable form for a destination, since the two feeds spell them differently. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function callOf(visit: MonitoredStopVisit): Record<string, unknown> | null {
  const journey = visit.MonitoredVehicleJourney as Record<string, unknown> | undefined
  if (!journey) return null
  const call = journey.MonitoredCall as Record<string, unknown> | undefined
  return call ?? null
}

function visitEpoch(visit: MonitoredStopVisit): number | null {
  const call = callOf(visit)
  if (!call) return null
  const raw = (call.ExpectedDepartureTime ?? call.ExpectedArrivalTime) as string | undefined
  if (!raw) return null
  const t = Date.parse(raw)
  return Number.isNaN(t) ? null : Math.floor(t / 1000)
}

function destinationOf(visit: MonitoredStopVisit): string {
  const journey = visit.MonitoredVehicleJourney as Record<string, unknown> | undefined
  return normalize(String(journey?.DestinationName ?? ''))
}

function isoSeconds(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Enriches BART's visits in place, returning what it managed to match.
 *
 * Matching is greedy and one-to-one within a station: each estimate claims the nearest
 * unclaimed visit going to the same place. Destination is used rather than a
 * north/south-to-inbound/outbound mapping, because the destination names are directly
 * comparable while the direction mapping would have to be derived and could silently
 * invert.
 */
export function enrichWithEtd(
  byStop: Map<string, MonitoredStopVisit[]>,
  etd: BartEtd,
  tables: BartGeometryTables,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): EtdMatchStats {
  const stats: EtdMatchStats = { visits: 0, estimates: 0, matched: 0, leavingClamped: 0 }

  for (const station of etd.stations) {
    const info = tables.stations.get(station.abbr)
    if (!info) continue

    // Every visit across every platform of this station, since BART reports per station
    // and the feed reports per platform.
    const candidates: MonitoredStopVisit[] = []
    for (const stopId of info.stopIds) {
      const visits = byStop.get(stopId)
      if (visits) candidates.push(...visits)
    }
    if (candidates.length === 0) continue
    stats.visits += candidates.length
    stats.estimates += station.estimates.length

    const claimed = new Set<MonitoredStopVisit>()

    for (const estimate of station.estimates) {
      const target = etd.fetchedAt + estimate.minutes * 60
      const wantDest = normalize(estimate.destination)

      let best: MonitoredStopVisit | null = null
      let bestDelta = Number.POSITIVE_INFINITY

      for (const visit of candidates) {
        if (claimed.has(visit)) continue
        const epoch = visitEpoch(visit)
        if (epoch === null) continue

        // Destination must agree where we have one on both sides; otherwise a
        // northbound and southbound train a minute apart could swap platforms.
        const haveDest = wantDest && destinationOf(visit)
        if (haveDest && destinationOf(visit) !== wantDest) continue

        const delta = Math.abs(epoch - target)
        if (delta < bestDelta) {
          bestDelta = delta
          best = visit
        }
      }

      if (!best || bestDelta > MATCH_WINDOW_SECONDS) continue

      claimed.add(best)
      stats.matched++
      applyEstimate(best, estimate, nowSeconds, stats)
    }
  }

  return stats
}

function applyEstimate(
  visit: MonitoredStopVisit,
  estimate: BartEstimate,
  nowSeconds: number,
  stats: EtdMatchStats,
): void {
  const journey = visit.MonitoredVehicleJourney as Record<string, unknown>
  const call = callOf(visit)
  if (!call) return

  // SIRI has a standard name for this one, so use it rather than inventing another.
  if (estimate.platform) call.DeparturePlatformName = estimate.platform

  /**
   * When BART says "Leaving", the doors are closing now.
   *
   * Clamping the time is the server-side half of the flooring fix, and it is the half
   * that reaches builds already on people's phones — a client rounding change never
   * will. Under either rounding rule a time of `now` renders as 0 minutes.
   *
   * This is not a fabrication: `Leaving` is BART's own authoritative flag, measured at
   * -84s..+81s around the true departure, and it is precisely what 511 lacks.
   */
  if (estimate.leaving) {
    const current = visitEpoch(visit)
    if (current === null || current > nowSeconds) {
      call.ExpectedDepartureTime = isoSeconds(nowSeconds)
      stats.leavingClamped++
    }
  }

  // Everything we invented lives in one closed bag, so the SIRI namespace stays clean
  // and a future reader can tell our fields from the standard's at a glance. Four
  // fields; adding a fifth should require an argument.
  journey.Extensions = {
    TrainLength: estimate.cars,
    DelaySeconds: estimate.delaySeconds,
    Leaving: estimate.leaving,
    Source: 'bart-etd',
  }
}
