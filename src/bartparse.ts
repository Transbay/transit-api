// Shaping BART's legacy API responses. No config, no network — so the quirks below can
// be pinned by tests without booting the service.

/** One predicted departure at one station. */
export interface BartEstimate {
  destinationAbbr: string
  destination: string
  /** "Leaving" arrives as 0. */
  minutes: number
  /** BART's own flag that the doors are closing. Measured at -84s..+81s, median +12s. */
  leaving: boolean
  platform: string
  /** "North" or "South". BART has no east/west, whatever the platform signs suggest. */
  direction: string
  cars: number
  delaySeconds: number
  hexcolor: string
}

export interface BartStationEtd {
  abbr: string
  name: string
  estimates: BartEstimate[]
}

export interface BartEtd {
  stations: BartStationEtd[]
  /** Epoch seconds when we received it — minutes are relative to this, not to now. */
  fetchedAt: number
}

export interface BartStation {
  abbr: string
  name: string
  lat: number
  lon: number
}

/**
 * BART's legacy API is inconsistent about single-element arrays — the same disease
 * `flexibleString` in `siri.ts` absorbs for 511. Normalise at every level rather than
 * discovering it one field at a time.
 */
export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

/** "Leaving" -> 0; "7" -> 7; anything else -> null so the estimate is dropped. */
function parseMinutes(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : null
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (s.toLowerCase() === 'leaving') return 0
  // `Number('')` is 0, which would put a phantom "Now" departure on the board for a
  // field BART simply left blank. An absent estimate is not an imminent train.
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null
}

function isLeaving(raw: unknown): boolean {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'leaving'
}

interface RawEstimate {
  minutes?: unknown
  platform?: unknown
  direction?: unknown
  length?: unknown
  color?: unknown
  hexcolor?: unknown
  delay?: unknown
}

/** Shapes one `etd.aspx` payload, tolerating every way BART writes a single element. */
export function parseEtd(root: unknown, fetchedAt: number): BartEtd {
  const r = (root as { root?: Record<string, unknown> })?.root ?? {}
  const stations: BartStationEtd[] = []

  for (const st of asArray(r.station as Record<string, unknown>[])) {
    const estimates: BartEstimate[] = []
    for (const etd of asArray(st.etd as Record<string, unknown>[])) {
      for (const e of asArray(etd.estimate as RawEstimate[])) {
        const minutes = parseMinutes(e.minutes)
        if (minutes === null) continue
        estimates.push({
          destinationAbbr: String(etd.abbreviation ?? ''),
          destination: String(etd.destination ?? ''),
          minutes,
          leaving: isLeaving(e.minutes),
          platform: String(e.platform ?? ''),
          direction: String(e.direction ?? ''),
          cars: Number(e.length ?? 0) || 0,
          delaySeconds: Number(e.delay ?? 0) || 0,
          hexcolor: String(e.hexcolor ?? '').replace(/^#/, '').toLowerCase(),
        })
      }
    }
    stations.push({
      abbr: String(st.abbr ?? '').toUpperCase(),
      name: String(st.name ?? ''),
      estimates,
    })
  }

  return { stations, fetchedAt }
}

