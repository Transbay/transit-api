import type { Deviation } from './deviation.js'

/**
 * Where each vehicle last was, for the prediction path.
 *
 * `predict()` walks a trip forward from an anchor: the last stop the vehicle was observed
 * to depart, and how late it was there. Without one it can only walk from the start of the
 * trip at the timetable, which ignores where the bus actually is -- and whether its driver
 * is running early today, since that estimator needs an anchor too.
 *
 * Fed from the deviations the poller already computes every cycle, so an anchor is at most
 * one poll old. Kept in this process: one small record per trip in service, dropped once
 * the trip goes quiet, so this is bounded by the fleet on the road (a few thousand
 * entries, well under a megabyte), not by anything a request can grow.
 */

export interface Anchor {
  stopId: string
  seq: number
  /** Seconds late at that stop's departure. Negative is early. */
  deviation: number
  /** When it departed, epoch seconds. */
  at: number
}

/** An anchor older than this says where the vehicle was, not where it is. */
export const ANCHOR_MAX_AGE_SECONDS = 900

const anchors = new Map<string, Anchor>()

/** Folds one cycle's observed departures in. Later stops on a trip replace earlier ones. */
export function recordAnchors(deviations: Deviation[]): void {
  for (const d of deviations) {
    if (d.actualDeparture === undefined) continue
    const prior = anchors.get(d.tripId)
    if (prior && prior.seq > d.seq) continue
    anchors.set(d.tripId, {
      stopId: d.stopId,
      seq: d.seq,
      deviation: d.devDeparture,
      at: d.actualDeparture,
    })
  }
}

/** The trip's anchor, if it has a fresh one. */
export function anchorFor(tripId: string, now: number): Anchor | undefined {
  const a = anchors.get(tripId)
  return a && now - a.at <= ANCHOR_MAX_AGE_SECONDS ? a : undefined
}

/** Drops anchors for trips that have gone quiet. Called once a cycle. */
export function pruneAnchors(now: number): void {
  for (const [trip, a] of anchors) {
    if (now - a.at > ANCHOR_MAX_AGE_SECONDS) anchors.delete(trip)
  }
}

export function anchorStatus(): { trips: number } {
  return { trips: anchors.size }
}
