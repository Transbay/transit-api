import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEtd } from './bartparse.js'
import { enrichWithEtd } from './bartetd.js'
import type { BartGeometryTables } from './geo.js'
import type { MonitoredStopVisit } from './siri.js'

// Every fixture below is shaped exactly as BART's live `etd.aspx` returns it, including
// the parts that are annoying: "Leaving" where a number belongs, and single elements
// that may or may not be wrapped in an array.

const T = 1_700_000_000

function etdPayload(estimates: unknown) {
  return {
    root: {
      station: [
        {
          name: 'Pittsburg/Bay Point',
          abbr: 'PITT',
          etd: [{ destination: 'Antioch', abbreviation: 'ANTC', estimate: estimates }],
        },
      ],
    },
  }
}

test('"Leaving" parses as 0 minutes and keeps its own flag', () => {
  const etd = parseEtd(
    etdPayload([
      { minutes: 'Leaving', platform: '1', direction: 'North', length: '9', delay: '0', hexcolor: '#ffff33' },
      { minutes: '9', platform: '1', direction: 'North', length: '9', delay: '358', hexcolor: '#ffff33' },
    ]),
    T,
  )
  const [leaving, later] = etd.stations[0].estimates
  assert.equal(leaving.minutes, 0)
  assert.equal(leaving.leaving, true)
  assert.equal(later.minutes, 9)
  assert.equal(later.leaving, false)
  assert.equal(later.delaySeconds, 358)
  assert.equal(later.cars, 9)
  assert.equal(later.hexcolor, 'ffff33', 'the leading # is stripped')
})

test('a single estimate arrives unwrapped and is still read', () => {
  // BART's legacy API drops the array when there is exactly one element — the same
  // disease `flexibleString` absorbs for 511.
  const etd = parseEtd(etdPayload({ minutes: '4', platform: '2', direction: 'South' }), T)
  assert.equal(etd.stations[0].estimates.length, 1)
  assert.equal(etd.stations[0].estimates[0].minutes, 4)
})

test('unparseable estimates are dropped, not turned into 0', () => {
  const etd = parseEtd(etdPayload([{ minutes: '' }, { minutes: 'soon' }, { minutes: '3' }]), T)
  assert.deepEqual(
    etd.stations[0].estimates.map((e) => e.minutes),
    [3],
  )
})

test('an empty payload yields no stations rather than throwing', () => {
  assert.deepEqual(parseEtd({}, T).stations, [])
  assert.deepEqual(parseEtd({ root: {} }, T).stations, [])
})

// ---------------------------------------------------------------------------
// Matching onto SIRI visits
// ---------------------------------------------------------------------------

function tables(): BartGeometryTables {
  return {
    shapes: new Map(),
    stopDist: new Map(),
    stopsOnShape: new Map(),
    tripShape: new Map(),
    stations: new Map([
      ['PITT', { abbr: 'PITT', name: 'Pittsburg/Bay Point', lat: 38, lon: -121.9, stopIds: ['903801'] }],
    ]),
    stationOfStop: new Map([['903801', 'PITT']]),
  }
}

function visit(destination: string, epochSeconds: number): MonitoredStopVisit {
  return {
    MonitoringRef: '903801',
    MonitoredVehicleJourney: {
      LineRef: 'Yellow-N',
      DestinationName: destination,
      MonitoredCall: {
        ExpectedDepartureTime: new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      },
    },
  } as MonitoredStopVisit
}

function extensionsOf(v: MonitoredStopVisit): Record<string, unknown> | undefined {
  return (v.MonitoredVehicleJourney as Record<string, unknown>).Extensions as
    | Record<string, unknown>
    | undefined
}

test('adds platform, car count and delay to the matching departure', () => {
  const v = visit('Antioch', T + 540)
  const byStop = new Map([['903801', [v]]])
  const etd = parseEtd(
    etdPayload([{ minutes: '9', platform: '1', direction: 'North', length: '9', delay: '358' }]),
    T,
  )

  const stats = enrichWithEtd(byStop, etd, tables(), T)
  assert.equal(stats.matched, 1)

  const call = (v.MonitoredVehicleJourney as Record<string, unknown>).MonitoredCall as Record<string, unknown>
  assert.equal(call.DeparturePlatformName, '1')
  assert.deepEqual(extensionsOf(v), {
    TrainLength: 9,
    DelaySeconds: 358,
    Leaving: false,
    Source: 'bart-etd',
  })
})

/**
 * The half of the flooring fix that reaches builds already on people's phones.
 *
 * A client rounding change never will, so "Leaving" clamps the time itself: under either
 * rounding rule, a departure at `now` renders as 0 minutes.
 */
test('"Leaving" clamps the departure to now', () => {
  const v = visit('Antioch', T + 40)
  const byStop = new Map([['903801', [v]]])
  const etd = parseEtd(etdPayload([{ minutes: 'Leaving', platform: '1' }]), T)

  const stats = enrichWithEtd(byStop, etd, tables(), T)
  assert.equal(stats.leavingClamped, 1)

  const call = (v.MonitoredVehicleJourney as Record<string, unknown>).MonitoredCall as Record<string, unknown>
  assert.equal(call.ExpectedDepartureTime, new Date(T * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'))
  assert.equal(extensionsOf(v)!.Leaving, true)
})

test('a departure to somewhere else is never claimed', () => {
  // Otherwise a northbound and a southbound train a minute apart could swap platforms.
  const v = visit('SFO', T + 540)
  const byStop = new Map([['903801', [v]]])
  const etd = parseEtd(etdPayload([{ minutes: '9', platform: '1' }]), T)

  assert.equal(enrichWithEtd(byStop, etd, tables(), T).matched, 0)
  assert.equal(extensionsOf(v), undefined)
})

test('an estimate more than 90s from any visit is left unmatched', () => {
  const v = visit('Antioch', T + 900)
  const byStop = new Map([['903801', [v]]])
  const etd = parseEtd(etdPayload([{ minutes: '9', platform: '1' }]), T)
  assert.equal(enrichWithEtd(byStop, etd, tables(), T).matched, 0)
})

test('matching is one-to-one: two estimates never claim the same visit', () => {
  const a = visit('Antioch', T + 540)
  const b = visit('Antioch', T + 1740)
  const byStop = new Map([['903801', [a, b]]])
  const etd = parseEtd(
    etdPayload([
      { minutes: '9', platform: '1', length: '9' },
      { minutes: '29', platform: '2', length: '6' },
    ]),
    T,
  )

  assert.equal(enrichWithEtd(byStop, etd, tables(), T).matched, 2)
  const platOf = (v: MonitoredStopVisit) =>
    ((v.MonitoredVehicleJourney as Record<string, unknown>).MonitoredCall as Record<string, unknown>)
      .DeparturePlatformName
  assert.equal(platOf(a), '1')
  assert.equal(platOf(b), '2')
})

test('a station with no GTFS mapping is skipped rather than throwing', () => {
  const empty: BartGeometryTables = { ...tables(), stations: new Map() }
  const v = visit('Antioch', T + 540)
  const byStop = new Map([['903801', [v]]])
  const etd = parseEtd(etdPayload([{ minutes: '9' }]), T)
  assert.equal(enrichWithEtd(byStop, etd, empty, T).matched, 0)
})
