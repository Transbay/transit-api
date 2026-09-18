import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCorrections, joinKey } from './correction.js'
import type { SIRIResponse } from './siri.js'
import type { PredictionEntry } from './predictions.js'

function visit(line: string, departure: string, arrival?: string) {
  return {
    MonitoringRef: '15419',
    MonitoredVehicleJourney: {
      LineRef: line,
      PublishedLineName: line,
      FramedVehicleJourneyRef: { DatedVehicleJourneyRef: '1234' },
      MonitoredCall: {
        ...(arrival ? { ExpectedArrivalTime: arrival } : {}),
        ExpectedDepartureTime: departure,
      },
    },
  }
}

function response(): SIRIResponse {
  return {
    ServiceDelivery: {
      ResponseTimestamp: '2026-09-09T18:00:00Z',
      StopMonitoringDelivery: {
        ResponseTimestamp: '2026-09-09T18:00:00Z',
        MonitoredStopVisit: [
          visit('14', '2026-09-09T18:10:00Z', '2026-09-09T18:09:30Z'),
          visit('49', '2026-09-09T18:12:00Z'),
          visit('14', '2026-09-09T18:20:00Z'),
        ],
      },
    },
  }
}

function prediction(line: string, raw: string, predicted: string, confidence: string): PredictionEntry {
  return {
    tripId: 'SF:x', lineRef: line, destination: '', stopId: '15419', raw, predicted,
    correctionSeconds: (Date.parse(predicted) - Date.parse(raw)) / 1000,
    p10: predicted, p50: predicted, p90: predicted, confidence,
    basis: { schedule: 0, profile: 0, block: 0, hold: 0, agencyError: 0 },
    evidence: { samples: 10, level: 'segment', dayType: 'weekday', bucket: 0, estimators: [], clamps: [], disagreementSeconds: 0 },
  } as PredictionEntry
}

const confident = (p: PredictionEntry) => p.confidence === 'high' || p.confidence === 'medium'

test('only accepted predictions move a time, and arrival moves with departure', () => {
  const input = response()
  const before = JSON.stringify(input)
  const { response: out, corrected } = applyCorrections(
    input,
    [
      prediction('14', '2026-09-09T18:10:00Z', '2026-09-09T18:11:30Z', 'high'),
      prediction('49', '2026-09-09T18:12:00Z', '2026-09-09T18:15:00Z', 'low'),
    ],
    confident,
  )
  assert.equal(corrected, 1)
  const visits = out.ServiceDelivery!.StopMonitoringDelivery!.MonitoredStopVisit!
  const call = (i: number) => (visits[i].MonitoredVehicleJourney as any).MonitoredCall
  assert.equal(call(0).ExpectedDepartureTime, '2026-09-09T18:11:30Z')
  assert.equal(call(0).ExpectedArrivalTime, '2026-09-09T18:11:00Z', 'dwell was not preserved')
  assert.equal(call(1).ExpectedDepartureTime, '2026-09-09T18:12:00Z', 'a low-confidence correction was applied')
  assert.equal(call(2).ExpectedDepartureTime, '2026-09-09T18:20:00Z', 'the wrong 14 moved')
  // The caller's copy -- possibly a cached response -- is still the agency's.
  assert.equal(JSON.stringify(input), before)
})

test('nothing accepted returns the very same response', () => {
  const input = response()
  const { response: out, corrected } = applyCorrections(
    input,
    [prediction('14', '2026-09-09T18:10:00Z', '2026-09-09T18:10:00Z', 'high')],
    confident,
  )
  assert.equal(corrected, 0)
  assert.equal(out, input)
})

test('the join key ignores case and sub-second noise', () => {
  assert.equal(joinKey('N', Date.parse('2026-09-09T18:10:00.400Z')), joinKey('n', Date.parse('2026-09-09T18:10:00Z')))
})
