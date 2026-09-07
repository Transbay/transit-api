import { config } from './config.js'
import { httpGetJSON, httpGetBytes } from './http.js'
import { parseEtd, asArray, type BartEtd, type BartStation } from './bartparse.js'

export { parseEtd, type BartEtd, type BartEstimate, type BartStationEtd } from './bartparse.js'
export type { BartStation } from './bartparse.js'

// BART's own APIs. Free, unmetered, and deliberately outside `upstream.ts` so they
// never touch the 511 key budget.
//
// Two of the three endpoints need no key at all. `etd.aspx` does, and it is the only
// source for platform number, car count, delay, and the authoritative "Leaving" flag —
// none of which 511 carries.

/** Every station's departures in one request. ~103 KB, ~0.7s. */
export async function fetchBartEtd(): Promise<BartEtd> {
  const url = new URL('etd.aspx', config.bart.baseUrl)
  url.searchParams.set('cmd', 'etd')
  url.searchParams.set('orig', 'ALL')
  url.searchParams.set('key', config.bart.apiKey)
  url.searchParams.set('json', 'y')

  const fetchedAt = Math.floor(Date.now() / 1000)
  const body = await httpGetJSON<unknown>(url, {
    timeoutMs: config.bart.timeoutMs,
    label: 'BART etd',
  })
  return parseEtd(body, fetchedAt)
}

/**
 * Station list with coordinates, for the nightly station table.
 *
 * BART labels these `gtfs_latitude`/`gtfs_longitude` — they are meant to line up with
 * GTFS, and they do: every station matches a GTFS platform within 80 m.
 */
export async function fetchBartStations(): Promise<BartStation[]> {
  const url = new URL('stn.aspx', config.bart.baseUrl)
  url.searchParams.set('cmd', 'stns')
  url.searchParams.set('key', config.bart.apiKey)
  url.searchParams.set('json', 'y')

  const body = await httpGetJSON<{
    root?: { stations?: { station?: Record<string, unknown>[] } }
  }>(url, { timeoutMs: config.bart.timeoutMs, label: 'BART stns' })

  const out: BartStation[] = []
  for (const s of asArray(body?.root?.stations?.station)) {
    const lat = Number(s.gtfs_latitude)
    const lon = Number(s.gtfs_longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    out.push({
      abbr: String(s.abbr ?? '').toUpperCase(),
      name: String(s.name ?? ''),
      lat,
      lon,
    })
  }
  return out
}

/** BART's own GTFS-RT trip updates. Needs no key at all. */
export async function fetchBartTripUpdates(): Promise<Uint8Array> {
  return httpGetBytes(config.bart.gtfsRtUrl, {
    timeoutMs: config.bart.timeoutMs,
    label: 'BART tripupdates',
  })
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

// A legacy endpoint that is down should not be hit 240 times an hour.
let consecutiveFailures = 0
let skipUntil = 0

const FAILURES_BEFORE_OPEN = 5
const OPEN_MS = 5 * 60_000

export function bartAvailable(): boolean {
  return config.bart.enabled && Date.now() >= skipUntil
}

export function recordBartSuccess(): void {
  consecutiveFailures = 0
  skipUntil = 0
}

export function recordBartFailure(): void {
  consecutiveFailures++
  if (consecutiveFailures >= FAILURES_BEFORE_OPEN) {
    skipUntil = Date.now() + OPEN_MS
    consecutiveFailures = 0
    console.warn(`[bart] ${FAILURES_BEFORE_OPEN} consecutive failures; pausing BART for 5 minutes`)
  }
}

export function bartBreakerStatus(): { open: boolean; resumesInSeconds: number } {
  const open = Date.now() < skipUntil
  return { open, resumesInSeconds: open ? Math.ceil((skipUntil - Date.now()) / 1000) : 0 }
}
