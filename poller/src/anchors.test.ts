import test from 'node:test'
import assert from 'node:assert/strict'
import { recordAnchors, anchorFor, pruneAnchors, ANCHOR_MAX_AGE_SECONDS } from './anchors.js'
import type { Deviation } from './deviation.js'

const T = 1_800_000_000

function dev(tripId: string, seq: number, devDeparture: number, at: number): Deviation {
  return { tripId, seq, stopId: `S${seq}`, devDeparture, actualDeparture: at } as Deviation
}

test('a trip anchors on its furthest observed departure', () => {
  recordAnchors([dev('a', 5, 60, T), dev('a', 3, 10, T - 200)])
  assert.deepEqual(anchorFor('a', T), { stopId: 'S5', seq: 5, deviation: 60, at: T })
  recordAnchors([dev('a', 6, -30, T + 90)])
  assert.equal(anchorFor('a', T + 90)?.seq, 6)
})

test('an arrival-only observation is not an anchor', () => {
  recordAnchors([{ ...dev('b', 2, 0, T), actualDeparture: undefined }])
  assert.equal(anchorFor('b', T), undefined)
})

test('a stale anchor says where the vehicle was, so it is not used and is pruned', () => {
  recordAnchors([dev('c', 4, 0, T)])
  const later = T + ANCHOR_MAX_AGE_SECONDS + 1
  assert.equal(anchorFor('c', later), undefined)
  pruneAnchors(later)
  assert.equal(anchorFor('c', T), undefined, 'pruned trips stay pruned')
})
