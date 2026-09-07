import { test } from 'node:test'
import assert from 'node:assert/strict'
import { placeTrain, typicalSpeedFor } from './bartposition.js'
import { metresBetween, type ShapePoint } from './geo.js'
import type { BartGeometryTables, StopInfo } from './gtfs.js'

// A straight 10 km run due north with three stations on it: A at 0, B at 4,000,
// C at 10,000. Distances are metres, as everything downstream assumes.
const SHAPE: ShapePoint[] = Array.from({ length: 101 }, (_, i) => ({
  lat: 37.8 + (i * 100) / 111_320,
  lon: -122.4,
  dist: i * 100,
}))

function tables(): BartGeometryTables {
  const stopDist = new Map<string, number>([
    ['S\x1fA', 0],
    ['S\x1fB', 4000],
    ['S\x1fC', 10_000],
  ])
  return {
    shapes: new Map([['S', SHAPE]]),
    stopDist,
    stopsOnShape: new Map([
      [
        'S',
        [
          { stopId: 'A', dist: 0 },
          { stopId: 'B', dist: 4000 },
          { stopId: 'C', dist: 10_000 },
        ],
      ],
    ]),
    tripShape: new Map([['BA:1', 'S']]),
    stations: new Map(),
    stationOfStop: new Map([
      ['A', 'AAA'],
      ['B', 'BBB'],
      ['C', 'CCC'],
    ]),
  }
}

function stops(): Map<string, StopInfo> {
  const at = (d: number) => ({
    name: `stop${d}`,
    lat: 37.8 + d / 111_320,
    lon: -122.4,
  })
  return new Map([
    ['A', at(0)],
    ['B', at(4000)],
    ['C', at(10_000)],
  ])
}

/** Metres along the shape of a returned placement. */
function distOf(lat: number): number {
  return metresBetween(37.8, -122.4, lat, -122.4)
}

const T = 1_000_000

test('speed depends on segment length, not on a neighbouring segment', () => {
  const shortHop = typicalSpeedFor(570) // a downtown BART hop
  const tube = typicalSpeedFor(9400) // the Transbay Tube
  assert.ok(shortHop > 5 && shortHop < 15, `short hop ${shortHop}`)
  assert.ok(tube > 20 && tube < 26, `tube ${tube}`)
  assert.ok(tube > shortHop, 'longer segments average faster')
  assert.equal(typicalSpeedFor(0), 0)
})

/**
 * The dominant case, and the one that was wrong first.
 *
 * The feed lists only *upcoming* stops, so a moving train is almost always before its
 * first prediction — 47 of 58 at a typical moment. Placing it at that stop instead
 * would show nearly the whole fleet parked in stations.
 */
test('a train en route to its first predicted stop is placed behind it, moving', () => {
  // Due at B in 100s. B is 4 km from A, so it is somewhere in between.
  const p = placeTrain([{ stopId: 'B', arrival: T + 100, departure: T + 118 }], T, 'S', tables(), stops())!
  assert.equal(p.atStation, false)
  assert.ok(p.speed > 0)
  const d = distOf(p.lat)
  assert.ok(d > 0 && d < 4000, `expected between A and B, got ${d}`)
  assert.ok(Math.abs(p.bearing! - 0) < 1, 'heading north along the shape')
})

test('it is never pushed back past the station it came from', () => {
  // Due at B in an implausible 10 minutes: it cannot have left A yet.
  const p = placeTrain([{ stopId: 'B', arrival: T + 600, departure: T + 618 }], T, 'S', tables(), stops())!
  assert.equal(p.atStation, true)
  assert.equal(p.speed, 0)
  assert.ok(distOf(p.lat) < 1, 'held at A')
})

/**
 * Dwell is exact, not modelled: both feeds publish an arrival *and* a departure for
 * essentially every BART stop, median 18s apart.
 */
test('a dwelling train does not move and reports zero speed', () => {
  const timeline = [
    { stopId: 'B', arrival: T - 10, departure: T + 10 },
    { stopId: 'C', arrival: T + 400, departure: T + 418 },
  ]
  const p = placeTrain(timeline, T, 'S', tables(), stops())!
  assert.equal(p.atStation, true)
  assert.equal(p.speed, 0)
  assert.ok(Math.abs(distOf(p.lat) - 4000) < 5, 'sitting at B')
})

test('between two known stops it interpolates and reports a measured speed', () => {
  const timeline = [
    { stopId: 'B', arrival: T - 300, departure: T - 300 },
    { stopId: 'C', arrival: T + 300, departure: T + 318 },
  ]
  const p = placeTrain(timeline, T, 'S', tables(), stops())!
  assert.equal(p.atStation, false)
  assert.equal(p.confidence, 'high')
  // Halfway through the 600s window over a 6 km segment.
  assert.ok(Math.abs(distOf(p.lat) - 7000) < 100, `expected ~7000, got ${distOf(p.lat)}`)
  assert.ok(Math.abs(p.speed - 10) < 0.5, '6000 m in 600 s')
})

test('it holds briefly at the terminal, then disappears rather than inventing track', () => {
  const timeline = [{ stopId: 'C', arrival: T - 100, departure: T - 60 }]
  const held = placeTrain(timeline, T, 'S', tables(), stops())!
  assert.equal(held.atStation, true)
  assert.ok(Math.abs(distOf(held.lat) - 10_000) < 5)

  assert.equal(placeTrain(timeline, T + 600, 'S', tables(), stops()), null)
})

test('a trip with no shape still yields a position, flagged low confidence', () => {
  const timeline = [
    { stopId: 'B', arrival: T - 300, departure: T - 300 },
    { stopId: 'C', arrival: T + 300, departure: T + 318 },
  ]
  const p = placeTrain(timeline, T, undefined, tables(), stops())!
  assert.equal(p.confidence, 'low')
  assert.ok(distOf(p.lat) > 4000 && distOf(p.lat) < 10_000)
})

test('an empty timeline places nothing rather than guessing', () => {
  assert.equal(placeTrain([], T, 'S', tables(), stops()), null)
})

/**
 * A station's platforms project to within a metre of each other, so "the previous stop"
 * has to mean the previous *station*. Otherwise a train's own opposite platform is
 * chosen and it is pinned in the station it is leaving.
 */
test('the previous station is not the opposite platform of the same station', () => {
  const t = tables()
  t.stopDist.set('S\x1fB2', 4001)
  t.stopsOnShape.get('S')!.push({ stopId: 'B2', dist: 4001 })
  t.stopsOnShape.get('S')!.sort((a, b) => a.dist - b.dist)
  t.stationOfStop.set('B2', 'BBB') // same station as B
  const s = stops()
  s.set('B2', s.get('B')!)

  // Due at B2 in 100s: it must be placed back toward A, not pinned on B a metre away.
  const p = placeTrain([{ stopId: 'B2', arrival: T + 100, departure: T + 118 }], T, 'S', t, s)!
  assert.equal(p.atStation, false)
  assert.ok(distOf(p.lat) < 4000)
})
