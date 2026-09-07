import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  projectOntoShape,
  pointAtDistance,
  bearingAt,
  metresBetween,
  packShape,
  unpackShape,
  remeasureInMetres,
  type ShapePoint,
} from './geo.js'

// A straight 1 km run due north from a point in the Bay Area, at 100 m spacing.
const NORTH: ShapePoint[] = Array.from({ length: 11 }, (_, i) => ({
  lat: 37.8 + (i * 100) / 111_320,
  lon: -122.4,
  dist: i * 100,
}))

test('projects a point that is exactly on the line', () => {
  const mid = NORTH[5]
  const hit = projectOntoShape(NORTH, mid.lat, mid.lon)
  assert.ok(hit)
  assert.ok(Math.abs(hit.dist - 500) < 1)
  assert.ok(hit.offset < 1)
})

test('projects a point offset to the side onto the nearest point of the line', () => {
  // 50 m east of the 300 m mark.
  const hit = projectOntoShape(NORTH, NORTH[3].lat, NORTH[3].lon + 50 / 88_000)
  assert.ok(hit)
  assert.ok(Math.abs(hit.dist - 300) < 2)
  assert.ok(Math.abs(hit.offset - 50) < 2)
})

test('clamps a point before the start and past the end', () => {
  const before = projectOntoShape(NORTH, 37.79, -122.4)!
  assert.equal(before.dist, 0)
  const after = projectOntoShape(NORTH, 37.82, -122.4)!
  assert.equal(after.dist, 1000)
})

test('pointAtDistance walks the line and clamps at both ends', () => {
  const mid = pointAtDistance(NORTH, 550)!
  assert.ok(Math.abs(metresBetween(mid.lat, mid.lon, NORTH[5].lat, NORTH[5].lon) - 50) < 1)

  // Never extrapolates onto track that doesn't exist.
  assert.equal(pointAtDistance(NORTH, -100)!.lat, NORTH[0].lat)
  assert.equal(pointAtDistance(NORTH, 99_999)!.lat, NORTH[NORTH.length - 1].lat)
})

test('bearing is compass degrees, not radians or maths convention', () => {
  assert.ok(Math.abs(bearingAt(NORTH, 0) - 0) < 0.5) // due north
  const east: ShapePoint[] = [
    { lat: 37.8, lon: -122.4, dist: 0 },
    { lat: 37.8, lon: -122.39, dist: 880 },
  ]
  assert.ok(Math.abs(bearingAt(east, 0) - 90) < 0.5)
})

test('pack/unpack round-trips within a tenth of a metre', () => {
  const back = unpackShape(packShape(NORTH))
  assert.equal(back.length, NORTH.length)
  for (let i = 0; i < NORTH.length; i++) {
    assert.ok(metresBetween(NORTH[i].lat, NORTH[i].lon, back[i].lat, back[i].lon) < 0.2)
    assert.ok(Math.abs(NORTH[i].dist - back[i].dist) <= 0.5)
  }
})

/**
 * The bug this exists for.
 *
 * `shape_dist_traveled` is unit-agnostic in GTFS, and the 511 regional feed publishes
 * BART shapes at roughly 3.05 m per unit. Self-consistent distances still place a train
 * correctly, so nothing looks wrong — but every speed comes out 3x too low, and 20 mph
 * for BART reads as entirely plausible.
 */
test('remeasureInMetres ignores the declared units and measures the geometry', () => {
  const inTenthsOfFeet: ShapePoint[] = NORTH.map((p, i) => ({ ...p, dist: i * 32.8 }))
  const fixed = remeasureInMetres(inTenthsOfFeet)

  assert.equal(fixed[0].dist, 0)
  assert.ok(Math.abs(fixed[fixed.length - 1].dist - 1000) < 2, 'total length is 1 km')
  for (let i = 1; i < fixed.length; i++) {
    assert.ok(fixed[i].dist > fixed[i - 1].dist, 'stays monotonic')
  }
})

test('degenerate shapes never throw', () => {
  assert.equal(projectOntoShape([], 37.8, -122.4), null)
  assert.equal(pointAtDistance([], 0), null)
  const single: ShapePoint[] = [{ lat: 37.8, lon: -122.4, dist: 0 }]
  assert.ok(projectOntoShape(single, 37.8, -122.4))
  assert.ok(pointAtDistance(single, 500))
  assert.deepEqual(remeasureInMetres([]), [])
})
