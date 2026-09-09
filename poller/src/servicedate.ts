/**
 * GTFS time algebra. Every date, clock and timezone concern in this service lives here
 * and nowhere else.
 *
 * Three things make transit time different from wall-clock time, and each of them has
 * a well-known way of going wrong:
 *
 * 1. **A service day is not a calendar day.** The 00:40 owl bus belongs to the previous
 *    day's schedule, and GTFS says so by letting stop times run past 24:00:00 —
 *    `25:12:00` is 01:12 tomorrow *on today's service date*. Parsing that with
 *    `Date.parse` produces `Invalid Date`; parsing it as 25 mod 24 produces a time
 *    twenty-three hours wrong.
 *
 * 2. **A service day is measured from noon minus twelve hours, not from midnight.** That
 *    is the actual wording in the GTFS spec, and it is not pedantry: on the spring-forward
 *    date, midnight-plus-eight-hours is 09:00 local, while noon-minus-twelve-plus-eight is
 *    08:00 local — which is when the bus actually runs. Two days a year, an entire
 *    agency's schedule is an hour wrong if you anchor on midnight. Noon is used precisely
 *    because no jurisdiction shifts its clocks at noon, so the offset at noon is
 *    unambiguous.
 *
 * 3. **The container runs in UTC.** `new Date().getHours()` is therefore a bug wherever
 *    it appears. Local time comes from `Intl` with an explicit zone, computed once per
 *    service date rather than once per row.
 */

/** Every operator in this feed runs on one clock. */
export const AGENCY_TZ = 'America/Los_Angeles'

const HOUR = 3600
const DAY = 86_400

/** Thirty-minute buckets, the resolution the delay profile is keyed on. */
export const BUCKET_SECONDS = 1800

/**
 * Buckets in a service day.
 *
 * Sixty, not forty-eight: a service day runs to roughly 30:00 for owl service, and a
 * bucket index that wrapped would file the 01:30 owl run alongside the 01:30 that does
 * not exist.
 */
export const BUCKETS_PER_DAY = 60

// ---------------------------------------------------------------------------
// Clock times
// ---------------------------------------------------------------------------

/**
 * `"27:15:00"` -> 98100. Seconds since the start of the service day.
 *
 * The hour field is deliberately unbounded. Returns null rather than NaN for anything
 * unparseable, so a malformed row is dropped at the edge instead of becoming a
 * plausible-looking zero.
 */
export function parseGtfsTime(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null

  // Hand-rolled rather than a regex with a `\d{1,3}` hour: GTFS in the wild contains
  // both `8:05:00` and `08:05:00`, and some producers omit the seconds entirely.
  const parts = s.split(':')
  if (parts.length < 2 || parts.length > 3) return null

  const h = Number(parts[0])
  const m = Number(parts[1])
  const sec = parts.length === 3 ? Number(parts[2]) : 0

  if (!Number.isInteger(h) || !Number.isInteger(m) || !Number.isInteger(sec)) return null
  if (h < 0 || m < 0 || m > 59 || sec < 0 || sec > 59) return null
  // 48 hours is already twice any real service day; beyond that the field is not a time.
  if (h > 47) return null

  return h * HOUR + m * 60 + sec
}

/** The inverse, for logs and debug pages. Keeps hours past 24. */
export function formatGtfsTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / HOUR)
  const m = Math.floor((s % HOUR) / 60)
  const sec = s % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Service dates
// ---------------------------------------------------------------------------

/** A calendar date in the agency's zone, `YYYY-MM-DD`. */
export type ServiceDate = string

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: AGENCY_TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function localPartsOf(epochMs: number): LocalParts {
  const out: Record<string, number> = {}
  for (const part of partsFormat.formatToParts(new Date(epochMs))) {
    if (part.type === 'literal') continue
    // `hour12: false` renders midnight as "24" in some ICU versions, so the hour -- and
    // ONLY the hour -- is normalised.
    //
    // Applying that to every field was a real bug, and an ugly one: the 24th of a month
    // became day 0, so `localDate` returned "2026-08-00" and one day in every thirty had
    // no valid service date at all. Nothing threw at the point of the mistake; Postgres
    // rejected the date hours later, in a query that had nothing to do with it.
    out[part.type] = part.type === 'hour' && part.value === '24' ? 0 : Number(part.value)
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  }
}

/** The zone's offset from UTC, in milliseconds, at a given instant. */
function offsetMsAt(epochMs: number): number {
  const p = localPartsOf(epochMs)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  // Millisecond component survives the round trip because we only ever add whole seconds.
  return asIfUtc - (epochMs - (epochMs % 1000))
}

/** `YYYY-MM-DD` for the calendar date an instant falls on, in the agency's zone. */
export function localDate(epochMs: number): ServiceDate {
  const p = localPartsOf(epochMs)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

function splitDate(date: ServiceDate): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number)
  return [y, m, d]
}

/**
 * Epoch milliseconds at the start of a service day — local noon minus twelve hours.
 *
 * Anchoring on noon is what makes this correct across DST. The offset is sampled at
 * noon, where it is never in the middle of a transition, and then subtracted; no
 * iteration is needed because no zone shifts its clocks at midday.
 */
export function serviceDayStartMs(date: ServiceDate): number {
  const [y, m, d] = splitDate(date)
  const noonAsIfUtc = Date.UTC(y, m - 1, d, 12, 0, 0)
  const offset = offsetMsAt(noonAsIfUtc)
  const noonLocal = noonAsIfUtc - offset
  return noonLocal - 12 * HOUR * 1000
}

/** Epoch seconds for a GTFS clock time on a service date. */
export function epochSecondsFor(date: ServiceDate, gtfsSeconds: number): number {
  return Math.round(serviceDayStartMs(date) / 1000) + gtfsSeconds
}

/** How far into a service day an instant falls. May exceed 86400, and may be negative. */
export function serviceSecondsOf(epochSeconds: number, date: ServiceDate): number {
  return epochSeconds - Math.round(serviceDayStartMs(date) / 1000)
}

/** Shifts a service date by whole days. */
export function shiftDate(date: ServiceDate, days: number): ServiceDate {
  const [y, m, d] = splitDate(date)
  // Noon again, so adding days can never land on a skipped or repeated hour.
  return localDate(Date.UTC(y, m - 1, d, 12, 0, 0) + days * DAY * 1000)
}

/**
 * The service dates a vehicle running *now* could plausibly belong to.
 *
 * Newest first. Yesterday is in the list because at 00:40 the owl bus is still running
 * yesterday's schedule; the day after is not, because no trip starts before its own
 * service day.
 */
export function candidateServiceDates(nowMs: number): ServiceDate[] {
  const today = localDate(nowMs)
  return [today, shiftDate(today, -1)]
}

// ---------------------------------------------------------------------------
// Buckets and day types
// ---------------------------------------------------------------------------

/**
 * Which half-hour of the service day a scheduled time falls in.
 *
 * Bucketed on *service-day* seconds, not wall clock, and that is a real decision rather
 * than an implementation detail: it files the 01:30 Friday-night owl run under hour 25 of
 * Friday, where it belongs, instead of under 01:30 Saturday alongside a route that has
 * been asleep for four hours.
 */
export function bucketOf(serviceSeconds: number): number {
  const b = Math.floor(serviceSeconds / BUCKET_SECONDS)
  return Math.min(BUCKETS_PER_DAY - 1, Math.max(0, b))
}

/**
 * The coarse calendar dimension the profile is keyed on.
 *
 * Six values, not seven. Tuesday, Wednesday and Thursday are the same day as far as
 * traffic is concerned — the variance between them is a handful of seconds, far below the
 * variance within any one of them — so keeping them apart would divide the evidence by
 * three and buy nothing. Monday and Friday genuinely differ: Monday mornings are lighter,
 * Friday afternoons start early and run heavy. Saturday, Sunday and holidays each have
 * their own service pattern as well as their own traffic.
 */
export enum DayType {
  Mon = 0,
  TueThu = 1,
  Fri = 2,
  Sat = 3,
  Sun = 4,
  Hol = 5,
}

export const DAY_TYPE_NAMES = ['Mon', 'Tue-Thu', 'Fri', 'Sat', 'Sun', 'Holiday'] as const

/** 0 = Sunday, matching `Date.getUTCDay()`, computed in the agency's zone. */
export function weekdayOf(date: ServiceDate): number {
  const [y, m, d] = splitDate(date)
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay()
}

export function dayTypeOf(date: ServiceDate, isHoliday = false): DayType {
  if (isHoliday) return DayType.Hol
  switch (weekdayOf(date)) {
    case 0:
      return DayType.Sun
    case 6:
      return DayType.Sat
    case 1:
      return DayType.Mon
    case 5:
      return DayType.Fri
    default:
      return DayType.TueThu
  }
}

/**
 * The day type a thin cell falls back to.
 *
 * Weekdays pool into Tue-Thu, which is the largest and most typical weekday population.
 * Holidays fall back to Sunday, which is what most operators actually run on them.
 * Saturday and Sunday do not pool into each other: Sunday service is materially thinner,
 * and merging them would let Saturday's frequency drag Sunday's estimate.
 */
export function parentDayType(dt: DayType): DayType | null {
  switch (dt) {
    case DayType.Mon:
    case DayType.Fri:
      return DayType.TueThu
    case DayType.Hol:
      return DayType.Sun
    default:
      return null
  }
}
