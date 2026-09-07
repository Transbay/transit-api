import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseGtfsTime,
  formatGtfsTime,
  serviceDayStartMs,
  epochSecondsFor,
  serviceSecondsOf,
  localDate,
  shiftDate,
  candidateServiceDates,
  bucketOf,
  dayTypeOf,
  parentDayType,
  DayType,
} from './servicedate.js'

// ---------------------------------------------------------------------------
// Clock times
// ---------------------------------------------------------------------------

test('parses ordinary and after-midnight clock times', () => {
  assert.equal(parseGtfsTime('08:05:00'), 8 * 3600 + 5 * 60)
  assert.equal(parseGtfsTime('8:05:00'), 8 * 3600 + 5 * 60)
  assert.equal(parseGtfsTime('08:05'), 8 * 3600 + 5 * 60)
  // The whole reason this function exists rather than Date.parse.
  assert.equal(parseGtfsTime('25:12:00'), 25 * 3600 + 12 * 60)
  assert.equal(parseGtfsTime('27:15:00'), 98_100)
})

test('refuses rather than guessing', () => {
  for (const bad of ['', '  ', 'noon', '08', '08:70:00', '08:05:99', '-1:00:00', '99:00:00']) {
    assert.equal(parseGtfsTime(bad), null, `expected null for ${JSON.stringify(bad)}`)
  }
})

test('formatting keeps hours past 24', () => {
  assert.equal(formatGtfsTime(98_100), '27:15:00')
  assert.equal(formatGtfsTime(0), '00:00:00')
})

// ---------------------------------------------------------------------------
// Daylight saving — the two days a year an agency's whole schedule can be an hour wrong
// ---------------------------------------------------------------------------

/** What anchoring on midnight instead of noon would have produced. */
function midnightAnchored(date: string, gtfsSeconds: number): number {
  const [y, m, d] = date.split('-').map(Number)
  const midnightLocal = Date.parse(
    new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) + 'T00:00:00-08:00',
  )
  return Math.round(midnightLocal / 1000) + gtfsSeconds
}

test('spring forward: an 08:00 trip is at 08:00 local, not 09:00', () => {
  // 2026-03-08 is the second Sunday in March; clocks jump 02:00 -> 03:00 PST -> PDT.
  const at = epochSecondsFor('2026-03-08', 8 * 3600)
  assert.equal(new Date(at * 1000).toISOString(), '2026-03-08T15:00:00.000Z') // 08:00 PDT

  // The bug this guards against, stated as an assertion rather than a comment.
  assert.notEqual(at, midnightAnchored('2026-03-08', 8 * 3600))
  assert.equal(midnightAnchored('2026-03-08', 8 * 3600) - at, 3600)
})

test('fall back: an 08:00 trip is still at 08:00 local', () => {
  // 2026-11-01 is the first Sunday in November; clocks fall 02:00 -> 01:00 PDT -> PST.
  const at = epochSecondsFor('2026-11-01', 8 * 3600)
  assert.equal(new Date(at * 1000).toISOString(), '2026-11-01T16:00:00.000Z') // 08:00 PST
})

test('a service day is 23 or 25 hours long across a transition', () => {
  // The short day is the one whose *end* crosses the transition, not the one the
  // transition falls in: service day 2026-03-07 runs from local midnight Saturday to
  // local midnight Sunday, and the clocks jump forward in between.
  const springStart = serviceDayStartMs('2026-03-07')
  const springEnd = serviceDayStartMs('2026-03-08')
  assert.equal((springEnd - springStart) / 3_600_000, 23)

  const fallStart = serviceDayStartMs('2026-10-31')
  const fallEnd = serviceDayStartMs('2026-11-01')
  assert.equal((fallEnd - fallStart) / 3_600_000, 25)
})

test('the repeated hour is two distinct owl runs, not one', () => {
  // The night of 2026-10-31 has 01:12 twice. GTFS resolves that unambiguously because
  // its times are elapsed seconds from the start of the service day, not clock readings:
  // 25:12 is the first, 26:12 the second, and they are an hour apart in real time.
  const clock = (epochSeconds: number) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(epochSeconds * 1000))

  const first = epochSecondsFor('2026-10-31', 25 * 3600 + 12 * 60)
  const second = epochSecondsFor('2026-10-31', 26 * 3600 + 12 * 60)

  assert.equal(clock(first), '01:12')
  assert.equal(clock(second), '01:12')
  assert.equal(second - first, 3600, 'an hour of real time separates two identical clocks')
})

test('an ordinary day is 24 hours', () => {
  const a = serviceDayStartMs('2026-09-06')
  const b = serviceDayStartMs('2026-09-07')
  assert.equal((b - a) / 3_600_000, 24)
})

// ---------------------------------------------------------------------------
// Service dates
// ---------------------------------------------------------------------------

test('an owl trip belongs to the previous service date', () => {
  // 01:12 local on Saturday morning, which is Friday's 25:12 run.
  const owl = epochSecondsFor('2026-09-04', 25 * 3600 + 12 * 60)
  assert.equal(localDate(owl * 1000), '2026-09-05', 'it happens on Saturday by the calendar')
  assert.equal(serviceSecondsOf(owl, '2026-09-04'), 25 * 3600 + 12 * 60)
  // ...and yesterday is offered as a candidate precisely so it can be attributed there.
  assert.deepEqual(candidateServiceDates(owl * 1000), ['2026-09-05', '2026-09-04'])
})

test('serviceSecondsOf inverts epochSecondsFor, DST included', () => {
  for (const date of ['2026-09-06', '2026-03-08', '2026-11-01']) {
    for (const s of [0, 6 * 3600, 12 * 3600, 25 * 3600 + 12 * 60]) {
      assert.equal(serviceSecondsOf(epochSecondsFor(date, s), date), s, `${date} ${s}`)
    }
  }
})

test('shiftDate crosses transitions without landing on a skipped hour', () => {
  assert.equal(shiftDate('2026-03-07', 1), '2026-03-08')
  assert.equal(shiftDate('2026-03-08', -1), '2026-03-07')
  assert.equal(shiftDate('2026-11-01', 1), '2026-11-02')
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01')
})

// ---------------------------------------------------------------------------
// Buckets and day types
// ---------------------------------------------------------------------------

test('buckets follow the service day past midnight', () => {
  assert.equal(bucketOf(0), 0)
  assert.equal(bucketOf(8 * 3600), 16)
  assert.equal(bucketOf(8 * 3600 + 1799), 16)
  assert.equal(bucketOf(8 * 3600 + 1800), 17)
  // The 01:30 owl run files under hour 25 of the previous day, not 01:30 of the next.
  assert.equal(bucketOf(25 * 3600 + 30 * 60), 51)
  assert.notEqual(bucketOf(25 * 3600 + 30 * 60), bucketOf(1 * 3600 + 30 * 60))
})

test('day types keep Monday and Friday apart but pool the middle', () => {
  assert.equal(dayTypeOf('2026-09-07'), DayType.Mon)
  assert.equal(dayTypeOf('2026-09-08'), DayType.TueThu)
  assert.equal(dayTypeOf('2026-09-09'), DayType.TueThu)
  assert.equal(dayTypeOf('2026-09-10'), DayType.TueThu)
  assert.equal(dayTypeOf('2026-09-04'), DayType.Fri)
  assert.equal(dayTypeOf('2026-09-05'), DayType.Sat)
  assert.equal(dayTypeOf('2026-09-06'), DayType.Sun)
  assert.equal(dayTypeOf('2026-09-07', true), DayType.Hol)
})

test('thin day types fall back somewhere defensible', () => {
  assert.equal(parentDayType(DayType.Mon), DayType.TueThu)
  assert.equal(parentDayType(DayType.Fri), DayType.TueThu)
  assert.equal(parentDayType(DayType.Hol), DayType.Sun)
  // Saturday must not borrow Sunday's evidence, or vice versa.
  assert.equal(parentDayType(DayType.Sat), null)
  assert.equal(parentDayType(DayType.Sun), null)
})
