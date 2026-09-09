# Prediction

Turning the profile into a time. `predict.ts`, with tests in `predict.test.ts`.

## Three estimators

Each produces a time **and its own honest variance**. The variance is the part that does the
work.

### E1 — schedule plus what the segments do

From the last stop confirmed passed, walk forward:

```
d_k = d_{k−1} + α_k + β_k · d_{k−1}          for each remaining segment
    then, at a timepoint:  d_k = max(d_k, hold_offset)
    finally:               d += λ · residual · steps          (see 06-block-state.md)

T₁ = scheduled_target + d
```

An AR(1), not a random walk, and the difference is the difference between a model that
settles and one that diverges. Summing average increments over twenty stops compounds them
without bound; a negative `β` pulls toward an equilibrium the way schedule slack actually
does.

**Variance is not the naive sum.** Adjacent segments are not independent — a jam spans
several stops, rain covers a whole route — so the sum is inflated by `1 + (m−1)·ρ` with
`ρ = 0.3`. Without it, a twenty-stop propagation claims a precision it does not have, and
because the fusion below weights on precision, an over-confident E1 would quietly take over
every prediction.

If the thinnest cell along the path has fewer than `PREDICTION_MIN_SAMPLES` effective
observations, **E1 is not offered at all.** A profile with nothing behind it must not be
able to move the answer.

### E2 — the agency's number, corrected

The feed's prediction plus the learned mean error for this context and horizon, from the
same ladder with the same shrinkage — and trained only from observation tiers that are
independent of the prediction being graded (see [`03-observation.md`](03-observation.md)).

Where no calibrated error profile exists, the agency's raw number is still offered, with a
deliberately pessimistic variance. An unmeasured agency should not silently dominate the
fusion by looking certain.

### E3 — nothing but this vehicle's own pace

E1 with the profile terms removed and only today's observed bias extrapolated. Weak on
purpose, with a wide variance: it exists so that a thin profile is not the only voice in the
room, not to carry a prediction.

## Fusion

```
T = Σ(Tₘ / σ²ₘ) / Σ(1/σ²ₘ)          σ² = 1 / Σ(1/σ²ₘ)
```

Inverse-variance weighting: the correct combination for approximately independent
estimators, no tuned weights, and **self-correcting** — an estimator whose measured history
says it is unreliable in this context stops mattering without anybody having to notice and
turn it down.

### What fusion hides

Nothing in that formula represents *disagreement*. Two estimators 900 seconds apart, each
with a tight variance, fuse to a confident number halfway between them — which is the exact
signature of a model about to be very wrong, and it is invisible in the output.

So `disagreement` is computed separately and reported, and the confidence gate refuses to
claim much when the estimators cannot agree. The test `disagreement is reported separately,
because fusion hides it` exists to keep that from being optimised away.

## The clamps

Every one of these exists because the unclamped version produces a number that is
arithmetically defensible and obviously wrong to anybody standing at the stop.

| Clamp | Rule | Without it |
|---|---|---|
| `tempered` | Correction shrunk by `n/(n+15)` | A cell with four observations asserts a five-minute correction |
| `capped` | Correction ≤ `max(90 s, 0.25 × horizon)` | A pathological profile moves a prediction by more than the prediction |
| `unreachable` | Never earlier than the vehicle could physically arrive from its last confirmed stop | A bus is predicted at a stop it cannot reach for twenty minutes |
| `timepoint-hold` | Never before a held stop's published time | A rider is told the bus is here when it left four minutes ago |
| `past` | Never in the past | Self-evident, and it happens constantly without the check |
| — | Any missing input returns the agency's number unchanged | An error, where there was a perfectly good answer available |

**Shrinkage rather than a threshold.** A hard cut at "fifteen observations" produces a
visible jump in the served number the instant a cell crosses it: the same bus, the same
second, a ninety-second change because one more observation arrived. `temper()` is
continuous and monotone, and its largest single step is under a tenth of what a threshold
would swing.

### Instrument the clamps

If clamps fire often, we are shipping the clamps rather than the model. Every activation is
named on the response and counted; more than about 5% of predictions hitting `capped` means
the profile is fighting the agency and the answer is to look at why, not to raise the cap.

This is the same idea as `implausibleSpeed` on the BART position synthesis: a canary that
should be zero if the arithmetic is right.

## Confidence

```
none    fewer than 3 effective samples, or only a route-level rung answered
low     estimators more than 10 minutes apart, or thin evidence
medium  ≥10 samples at segment level or finer
high    ≥30 samples, segment × day type or finer, estimators within 3 minutes
```

Deliberately **not** a function of how large the correction is. A big correction backed by
four hundred observations is more trustworthy than a small one backed by four. What
downgrades confidence is thin evidence, a coarse rung, or estimators that disagree.

## What gets published

`/v1/departures` is untouched. Same SIRI envelope, same raw agency times in `Expected*`,
byte-compatible with builds that have been on people's phones for months.

Corrections live on `GET /v1/predictions?agency=&stopcode=`:

```json
{
  "agency": "SM", "stopCode": "473230", "mode": "shadow", "cold": false,
  "predictions": [{
    "tripId": "SM:...", "lineRef": "172",
    "raw":       "2026-09-04T16:14:00Z",
    "predicted": "2026-09-04T15:57:12Z",
    "correctionSeconds": -1008,
    "p10": "...", "p50": "...", "p90": "...",
    "confidence": "high",
    "basis":    { "schedule": 1757001240, "profile": -998, "block": -55,
                  "hold": 0, "agencyError": -12 },
    "evidence": { "samples": 84, "level": "segment x daytype x 30min",
                  "dayType": "Fri", "bucket": 16,
                  "estimators": [{ "name": "profile", "time": ..., "weight": 0.71 },
                                 { "name": "agency",  "time": ..., "weight": 0.29 }],
                  "clamps": ["tempered"], "disagreementSeconds": 240 }
  }]
}
```

`basis` and `evidence` are not debug output. **A seventeen-minute correction is only worth
anything if the reader can see where it came from and how many observations stand behind
it** — an unexplained number that large is indistinguishable from a bug and should be
treated as one until it explains itself.

An entry the model declines to correct comes back with `predicted == raw` and
`confidence: "none"` rather than being omitted, so a consumer never has to guess whether a
missing correction means "no opinion" or "no data".

## Why not `/v1/departures`

Because it is a decision, not a default.

The iOS client derives "is this realtime" purely from which SIRI field a time arrives in
(`Expected*` versus `Aimed*`). Moving corrected times into the departures feed means
deciding, deliberately, that a model-adjusted time is a live sighting — and if that decision
were made by accident it would reach every widget in the field with no way to tell.

Keeping corrections on a new endpoint means nothing in this half of the service can change
what a phone receives, and the iOS contract tests stay green by construction rather than by
care. [`07-evaluation.md`](07-evaluation.md) records what would have to be true to change
that.

## Modes

`PREDICTION_MODE`:

- **`off`** — nothing computed. `/v1/predictions` returns raw values only.
- **`shadow`** *(default)* — computed, logged, scored, and reported at `confidence:
  "shadow"` with `predicted == raw`. This is where a new agency starts.
- **`on`** — the gate in `07-evaluation.md` decides per agency and per horizon.

Even in `on`, `/v1/departures` is unaffected.
