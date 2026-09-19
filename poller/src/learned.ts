import { predictionsFor } from './predictions.js'
import { joinKey } from './correction.js'
import { config } from './config.js'
import { maybeSample } from './accuracy.js'

/**
 * The profile, applied to a board.
 *
 * Shared by the general board and the BART board so the purple means the same thing on
 * both. Only ever adds fields: the agency's own `epochMs` is never overwritten.
 */

/** What a board row needs for this to mark it. */
export interface Learnable {
  line: string
  /** The agency's own time. Never overwritten. */
  epochMs: number
  /** Set only where the profile had something to say. */
  correctedMs?: number
  correctionSeconds?: number
  confidence?: string
  samples?: number
  /**
   * The same-day vehicle term, in seconds.
   *
   * This is the driver running consistently hot or cold today, measured as a residual
   * against what the profile expected rather than against the timetable -- so a bus on a
   * genuinely slow corridor is not mistaken for a slow driver. Surfaced because it is the
   * part of a correction a reader can sanity-check from the platform.
   */
  blockSeconds?: number
}

/**
 * Where a board's departures fell out of the purple, stage by stage. Returned in the
 * boards' JSON so a board with no purple says why without anyone needing server access.
 */
export interface LearnedTrace {
  stop: string
  /** Predictions the model returned for this stop, and how many were cold (no profile). */
  predictions: number
  cold: boolean
  /** Departures with a prediction joined to them on line and agency time. */
  matched: number
  /** Joined, but our time was within 30s of the agency's. */
  small: number
  /** Joined and different, but backed by fewer than `minSamples` observations. */
  thin: number
  marked: number
  /**
   * Each joined departure as `[our time minus the agency's in seconds, samples, confidence,
   * anchored on the vehicle's last departure, clamps that fired]`.
   * Exact zeros at confidence `none` are the agency's number passed through (no trip in the
   * timetable); zeros at `shadow` are the model running and agreeing.
   */
  joined: [number, number, string, boolean, string][]
  error?: string
}

/**
 * Marks each departure the profile would move, and returns how many it marked.
 *
 * Wrapped because the learned half must never be able to break the live half: a warehouse
 * that is down, cold or wrong costs the corrections and nothing else, and the board still
 * shows exactly what the agency said.
 */
export async function annotateLearned(
  agency: string,
  stopCode: string,
  departures: Learnable[],
  trace?: LearnedTrace[],
): Promise<number> {
  if (!config.profile.agencies.includes(agency)) return 0

  const t: LearnedTrace = { stop: stopCode, predictions: 0, cold: true, matched: 0, small: 0, thin: 0, marked: 0, joined: [] }
  trace?.push(t)
  let corrected = 0
  try {
    const predicted = await predictionsFor(agency, stopCode)
    maybeSample(predicted)
    t.predictions = predicted.predictions.length
    t.cold = predicted.cold

    // Joined on line and the agency's own time; see `joinKey` for why not the trip id.
    const byKey = new Map(
      predicted.predictions.map((p) => [joinKey(p.lineRef, Date.parse(p.raw)), p]),
    )

    for (const d of departures) {
      const p = byKey.get(joinKey(d.line, d.epochMs))
      if (!p) continue
      t.matched++

      // `p50` rather than `predicted`, deliberately.
      //
      // In shadow mode `predicted` is the agency's own time: the gate is about what the
      // public API is willing to *claim*, and that gate should not be weakened to make an
      // internal page more interesting. But the model's actual estimate is still there in
      // `p50`, and the boards exist to show it -- marked, in purple, next to the agency's
      // number, so it can be argued with. `/v1/departures` is untouched either way.
      const ms = Date.parse(p.p50)
      if (Number.isNaN(ms)) continue

      const delta = Math.round((ms - Date.parse(p.raw)) / 1000)
      t.joined.push([delta, Math.round((p.evidence?.samples ?? 0) * 10) / 10, p.confidence,
        p.evidence?.anchored === true, (p.evidence?.clamps ?? []).join(',')])
      // Under half a minute is not a correction anybody can act on, and marking it purple
      // would make the indicator meaningless by making it permanent.
      if (Math.abs(delta) < 30) {
        t.small++
        continue
      }

      // And it must actually have been learned from something.
      //
      // `predict` accepts an estimate with no evidence when the target needs no propagation
      // (predict.ts, `prop.steps === 0`), which is defensible for an API that reports its
      // own sample count. It is not defensible here: every such correction was landing on
      // the scheduled second, so the board was drawing the timetable in purple and calling
      // it learned. A marker that means "we know something" has to be backed by something.
      const samples = p.evidence?.samples ?? 0
      if (samples < config.predictions.minSamples) {
        t.thin++
        continue
      }

      d.correctedMs = ms
      d.correctionSeconds = delta
      d.confidence = p.confidence
      d.samples = p.evidence?.samples
      const blk = Math.round(p.basis?.block ?? 0)
      if (Math.abs(blk) >= 15) d.blockSeconds = blk
      corrected++
    }
  } catch (err) {
    // No corrections today.
    t.error = (err as Error).message
  }
  t.marked = corrected
  return corrected
}

/** The purple, in one place, for every board that draws a learned time. */
export const LEARNED_STYLE = `
.tag { display:inline-block; font-size:.62rem; letter-spacing:.09em; text-transform:uppercase;
       font-weight:700; color:#A78BFA; border:1px solid #8B6BF055; border-radius:5px;
       padding:0 .3rem; margin-left:.4rem; vertical-align:.08em; }
.cd.learned { color:#A78BFA; }
.was { display:block; font-size:.7rem; color:var(--ink-faint); font-weight:400;
       font-family:var(--font-body); }
.banner { display:flex; align-items:center; gap:.55rem; padding:.6rem .85rem;
          border-radius:12px; margin-bottom:1rem; font-size:.84rem; }
.banner.learned { border:1px solid #8B6BF055; background:#8B6BF014; color:#A78BFA; }
.banner.learned a { color:#C4B5FD; text-decoration:underline; }
.pdot { width:8px; height:8px; border-radius:50%; background:#8B6BF0; flex:none; }
`
