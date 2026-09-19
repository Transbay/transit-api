import { flexibleString, type SIRIResponse } from './siri.js'
import type { PredictionEntry } from './predictions.js'

/**
 * Learned times, written into the SIRI envelope the app already reads.
 *
 * `/v1/predictions` carries corrections alongside their evidence, for a client that knows
 * to ask. The builds already on people's phones never will, so behind `DEPARTURES_CORRECTED`
 * the same corrections can be applied to `/v1/departures` instead: same envelope, same
 * fields, only the expected times moved. Kept free of config and I/O so the rule can be
 * tested on its own; the caller decides which predictions are trustworthy enough.
 */

/**
 * The key a SIRI visit and a prediction are joined on: line plus the agency's own time.
 *
 * Not the trip id. SIRI's DatedVehicleJourneyRef is `shortName || stripAgencyPrefix(tripId)`
 * (gtfsrt.ts) while the prediction index is keyed on the agency-qualified id, so joining on
 * it silently matched nothing. Both sides are built from the same feed entry, so the raw
 * time is identical rather than merely close.
 */
export function joinKey(line: string, epochMs: number): string {
  return `${line.toLowerCase()}|${Math.round(epochMs / 1000)}`
}

/** ISO8601 the way 511's SIRI writes it: whole seconds, `Z`. */
function isoSeconds(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Returns a copy of `response` with each accepted prediction's shift applied, and how many
 * visits moved. The input is never mutated, so a cached response stays the agency's.
 *
 * Arrival and departure move by the same amount, so a visit's dwell is preserved. A visit
 * with no matching accepted prediction is returned exactly as it came.
 *
 * A moved visit also says so, in `MonitoredCall.Extensions`: `Adjusted: true` and the
 * agency's own time. That is what lets a client mark the time as ours rather than pass it
 * off as the agency's. Builds that predate it decode past unknown keys.
 */
export function applyCorrections(
  response: SIRIResponse,
  predictions: PredictionEntry[],
  accept: (p: PredictionEntry) => boolean,
): { response: SIRIResponse; corrected: number } {
  const shifts = new Map<string, number>()
  for (const p of predictions) {
    if (!accept(p)) continue
    const raw = Date.parse(p.raw)
    const predicted = Date.parse(p.predicted)
    if (Number.isNaN(raw) || Number.isNaN(predicted) || raw === predicted) continue
    shifts.set(joinKey(p.lineRef, raw), predicted - raw)
  }
  if (shifts.size === 0) return { response, corrected: 0 }

  const copy = structuredClone(response)
  const visits = copy.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit ?? []
  let corrected = 0

  for (const visit of visits) {
    const journey = visit.MonitoredVehicleJourney as Record<string, unknown> | undefined
    const call = journey?.MonitoredCall as Record<string, unknown> | undefined
    if (!journey || !call) continue

    const line =
      flexibleString(journey.PublishedLineName) ?? flexibleString(journey.LineRef) ?? ''
    const expected = (call.ExpectedDepartureTime ?? call.ExpectedArrivalTime) as
      | string
      | undefined
    if (!line || !expected) continue

    const shift = shifts.get(joinKey(line, Date.parse(expected)))
    if (shift === undefined) continue

    const ext = (call.Extensions ?? {}) as Record<string, unknown>
    call.Extensions = {
      ...ext,
      Adjusted: true,
      AgencyExpectedDepartureTime: isoSeconds(Date.parse(expected)),
    }

    for (const field of ['ExpectedDepartureTime', 'ExpectedArrivalTime']) {
      const value = call[field]
      if (typeof value !== 'string') continue
      const ms = Date.parse(value)
      if (!Number.isNaN(ms)) call[field] = isoSeconds(ms + shift)
    }
    corrected++
  }

  return { response: copy, corrected }
}
