# Roadmap

What is deliberately not built yet, why, and what it would take. Roughly in order of value
per unit of work.

## Before anything else: run the forensics

```
npm run build && node dist/forensics.js 60 30
```

Everything in [`03-observation.md`](03-observation.md) is a design against assumptions. The
σ per tier are starting values, and **which tiers are available per agency is an empirical
question whose answer changes what the profile is worth.** If no operator sets
`current_status`, direct observation does not exist, every actual time is inferred from a
prediction, and the prediction-error model has to stay off for everybody rather than just
for BART.

This costs two 511 requests per sample and an hour of waiting. Do it before tuning anything.

## Split `β` into recovery and bunching

The largest known modelling error, named in [`04-delay-profiles.md`](04-delay-profiles.md).

`β` currently pools two mechanisms with opposite signs. Slack recovery is a function of
lateness. Bunching is a function of **headway deviation**: a bus ten minutes late on a
six-minute headway is four minutes behind an on-time bus, picks up nobody and speeds up,
while the same ten minutes on an hourly route has no such channel at all. Pooling frequent
and infrequent routes into one slope averages the two into something that describes neither.

```
Δ_i = α + β·d_{i−1} + γ·Δh_{i−1}
```

`γ` is the more actionable number and nobody publishes it.

**What it needs:** the headway term, which is already observed — every vehicle at every stop
is exactly what a headway is. Two more accumulators per cell and a headway column on the
observation row. The blocker is not data, it is that `γ` should be validated in shadow before
it touches a served number, and that means the evaluation harness has to be reporting first.

## Instrument-error correction for the slope

Related, and cheap. `d_{i−1}` is measured, so the regression is biased toward zero, and with
inferred observations the bias is around 0.20 — enough to "discover" spurious delay
absorption on exactly the segments whose observations are worst.

Currently defended by restricting the regression to direct tiers and shrinking the fit.
Better: instrument with the lag-2 deviation, whose measurement error is uncorrelated with
`d_{i−1}`'s:

```
β_IV = Cov(Δ_i, d_{i−2}) / Cov(d_{i−1}, d_{i−2})
```

Three more streaming accumulators. The alternative — binning the response into five ranges
of prior deviation — is more robust still and degrades to bin misclassification rather than
attenuation, at the cost of needing more data per cell.

## A geometric observation tier

`geo.ts` already projects a point onto a polyline in metres, and does it for every BART
shape nightly. Extending that to the other four agencies would add a tier between A2 and C:
watch a vehicle's position cross a stop's projection and interpolate the crossing time
between two samples.

**Worth it only if the forensics say `current_stop_sequence` is patchy.** Where it is
populated, the sequence transition is both cheaper and more accurate. Where it is not, this
is the difference between a usable profile and one built on converged predictions.

Cost: `shapes.txt` for five agencies instead of one — the prefilter already supports it —
plus stop-to-shape projections nightly. Memory is the constraint, which is another argument
for it living in the schedule service.

## Observed blocks for BART and Caltrain

Neither publishes `block_id` — measured, 0 of 4,417 BART trips and 0 of 260 Caltrain trips.
So neither gets the terminal-layover model, which is unfortunate given that both run long
trips with substantial scheduled turnarounds and are exactly where layover absorption is
most predictable.

A block is, operationally, "the sequence of trips one vehicle runs". That is observable:
chain trips by `vehicle_id` as they are seen, in service-date order, and the gap between one
trip's last stop and the next trip's first is the layover. It needs a day of observation
before it is usable each morning, and it needs care where a vehicle id is reused, but it
turns an unavailable model into an available one for two of the five agencies.

## Weather

Rain has a large, well-documented effect on surface transit speeds, and it is the largest
single source of unexplained variance in any delay model that ignores it.

A daily precipitation and temperature series for one metro area is a small amount of data
from a free API. The modelling is a covariate on the segment cell — most simply a `wet`
flag as a second day-type dimension, which multiplies the cell count by two and is the
reason to think about it rather than just do it.

**The honest sequencing:** measure how much of the residual variance is weather-shaped
before adding a dimension for it. That analysis is possible today from the observation
table, without touching the model.

## Special-event days

Muni around a Giants or Warriors letout is a different network. So is Bay to Breakers,
Pride, Fleet Week and about a dozen others. These are currently swept into the anomaly gate
in [`03-observation.md`](03-observation.md), which keeps them out of the profile — correct,
but it means they are never *predicted* either, and they are among the days a rider most
wants a prediction.

Needs an event calendar, which means either a maintained list or a schedule-based heuristic.
The heuristic exists already in a weak form: the anomaly detector notices the day. Turning
"today is unusual" into "today is a letout, and here is what letouts do" is a second profile
dimension with very few observations behind it.

## Headway prediction for frequent service

On a six-minute headway a rider does not care which bus it is. They care that one is coming
in four minutes. The trip-level prediction can be materially wrong while the headway
prediction is fine, and the headway is what a board should show.

Different quantity, different model, same observations. Would change what `/v1/predictions`
returns for frequent routes.

## Backfill and replay

The observation table holds ninety days of trip-level history in a form the learner could
replay. A `backfill` tool would let a modelling change be evaluated against real history
instead of waiting three weeks to find out.

This is the highest-value item for anybody actually iterating on the model, and it is mostly
plumbing: read `trip_observation`, reconstruct `Deviation` rows, run them through
`learner.learnFrom` against a scratch schema, score the result.

## Cross-agency corridors

The corridor rung currently pools routes within one agency. Muni and SamTrans share corridors
on the peninsula; AC Transit and Golden Gate share the bridge. Physically it is the same
traffic.

The obstacle is stop identity: two agencies serving the same street have different stop ids
at slightly different kerb positions, so pooling needs a geographic match rather than an id
match, with a distance threshold and all the ways that goes wrong. Real value, real care
required.

## An ML upgrade path, and why it is last

Gradient boosting on `(segment, time, day, weather, headway, upstream deviation, vehicle
bias)` would very likely beat this model on raw error.

It is last deliberately:

- **The current model is auditable.** Every number on `/v1/predictions` decomposes into a
  basis and an evidence count. A seventeen-minute correction can be explained to somebody
  who does not trust it. That property is worth a lot of MAE.
- **It degrades honestly.** A segment with no data returns its parent and says so. A tree
  ensemble returns a confident number for a segment it has never seen.
- **The hard part is not the model.** It is [`03-observation.md`](03-observation.md) — the
  labels. Better labels improve any model; a better model on the same labels improves one.

The sensible order is: fix the observation layer, get the evaluation harness reporting
honestly, split `β`, and *then* ask whether a learned model beats the structured one on the
same data. If it does, the structured one is still the fallback for cold segments and still
the thing that explains itself.

## Not planned

**Serving corrections on `/v1/departures`.** Conditions in
[`07-evaluation.md`](07-evaluation.md); until all five are met, this stays on its own
endpoint.

**Profiling more agencies — no longer accurate; see below.** This said the five chosen are
the ones the app's users actually save. That reasoning held while the only consumer was a
widget over a handful of saved stops. It stopped holding when `headways` began rendering
every operator the regional feed carries, because now somebody *has* asked about all
twenty-four.

The split today is by what a measurement costs, not by which agencies matter:

- **Prediction drift** (`drift.ts` → `prediction_error`) runs for **every agency**. It needs
  no schedule, no `stop_times` and no observation pipeline — only the trip-update stream —
  so an extra operator costs nothing and is not gated on `PROFILED_AGENCIES`.
- **Segment profiles** (`profile.ts` → `segment_profile`) still cost per-stop-event storage
  and a schedule build, so they remain a configuration change and three weeks of waiting.
  Widening them is planned, staged largest-operator-first, and bounded by Redis memory for
  the hot blobs (~51 MB at five agencies) rather than by Postgres.

**Per-user or per-device anything.** This service holds no user data and no request history,
and the analysis endpoints are open precisely because there is nothing in them to protect.
Keeping it that way is worth more than any feature that would change it.
