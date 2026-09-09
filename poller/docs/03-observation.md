# Observation

> Read this before the statistics. Every number the model produces is only as good as the
> inference in this document, and the inference is the part most likely to be wrong in a way
> that looks fine.

## The problem, stated plainly

**GTFS-Realtime never says when a vehicle left a stop.**

It says when a vehicle *will* leave, over and over, each time a little more accurately, and
then it stops mentioning the stop at all. There is no event, no timestamp, no record. The
thing this entire system measures is not published by anybody.

So it has to be inferred. And because the quality of that inference varies by operator, by
hour, and by which optional protobuf fields a producer happens to populate, the inference
is **tiered** — every observation carries the tier it came from and the uncertainty that
tier deserves, and nothing averages across tiers silently.

## The tiers

| Tier | Evidence | Typical error | Can measure dwell |
|---|---|---|---|
| **A1** | The vehicle reported `STOPPED_AT` this stop, then reported being past it | ~12 s | yes |
| **A2** | The vehicle's `current_stop_sequence` advanced past this stop, never seen stopped | ~15 s + half the report gap | no |
| **B** | The sequence jumped over this stop; crossing time interpolated by scheduled running time | 35 s, growing with the gap | no |
| **C** | The last prediction observed before the stop left the feed, corrected by a measured calibration | ~45 s, **biased** | no |
| **Cu** | The same, with no calibration available for this agency | ~90 s, biased | no |
| **D** | Closed out from stale state | minutes | no |

Implemented in `observe.ts`. Weights are inverse-variance and normalised so that a tier-A1
sighting counts as 1: a tier-C observation is worth about 0.07 of one, and a tier-Cu about
0.02. That is what makes it safe to mix them in a mean.

`TIER_SIGMA` in that file holds starting values, not measurements. They should be re-derived
per agency from the *vehicle's own* reporting cadence: we sweep every fifteen seconds, but a
vehicle that reports every forty-five is not observed to fifteen no matter how often we ask.

## Three traps, each of which produces confident nonsense

### 1. The protobuf default

`VehiclePosition.current_status` is declared in GTFS-RT with `[default = IN_TRANSIT_TO]`.
protobufjs therefore returns `IN_TRANSIT_TO` for a producer that never wrote the field at
all — indistinguishable, read naively, from a real fleet that happens to be moving.

Read that way, an operator who publishes no status becomes an operator whose vehicles are
permanently in transit and never stopped, and every stop transition becomes a tier-A2
observation. An entire agency's worth of high-confidence history, manufactured out of a
field nobody set.

`rtdecode.ts` checks for the *property*, never for the value:

```ts
function present(msg: object, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(msg, field)
}
```

Decoded messages carry own properties only for fields that were on the wire; unset optional
fields fall through to a prototype default. `observe.test.ts` pins this with a test whose
whole job is to assert that an absent status produces no A-tier events.

### 2. Circularity

Tier C is a prediction. Using it to grade a *predictor* measures how fast that predictor
converges on itself, not whether it was right — and it does so in a direction that
systematically flatters the agency.

So the two models are trained from different populations:

- **The schedule-deviation model** (`04-delay-profiles.md`) measures against the timetable,
  which is independent of anything the realtime feed says. Tier C is admissible.
- **The prediction-error model** measures against the agency's own predictions. Tier C is
  **not** admissible without a calibration, and tier Cu never is.

The calibration measures, on the subset where both a direct and an inferred observation
exist for the same event, the distribution of `inferred − direct` per agency and period. An
agency with no direct observations at all — BART — keeps its prediction-error model
disabled rather than trained on itself. `tier_calibration` in the schema holds this; until
a row exists for an agency, that agency's inferred observations stay at the wider tier.

### 3. The frozen producer

An operator's feed can freeze while the *regional* feed's header keeps advancing, because
that header belongs to 511 and not to the operator. A frozen producer's stops never leave
the list and its predictions never move — which reads exactly like a fleet whose predictions
have all converged, and would mint a cycle's worth of fictional passage events every fifteen
seconds until somebody noticed.

`observe.ts` fingerprints each agency's whole set of predicted times per cycle and suppresses
a cycle that is byte-identical to the last. With a floor: below a handful of trips,
"nothing changed" is not evidence of anything — at three in the morning an operator can
legitimately have two trips out whose predictions genuinely did not move in fifteen seconds,
and suppressing those would blind the profile to exactly the hours that are hardest to
collect.

## Trip identity

An observation with no schedule has no deviation, so matching a live trip to a scheduled one
is where silent corruption enters. Four routes, in order, each recorded on the row:

1. **`trip_id` matches.** The overwhelming majority.
2. **The descriptor matches** — route, direction, start time and start date identify exactly
   one scheduled trip.
3. **Nearest scheduled start** on the same route and direction within ten minutes, where the
   observed stop sequence is a prefix of exactly one pattern.
4. **No match.** Logged, never trains anything.

### The service-change hole, and how it is closed

511 publishes a new schedule hours before the archive we mirror catches up. During that
window, trips appear in the realtime feed that the newest static tables have never heard of.
For *names* this degrades gracefully — the README's existing warning covers it. For
*learning* it is total: an unmatched trip has no schedule, so the pipeline goes dark for
that agency for a day or two, several times a year.

`warehouse.ts` keeps **three feed versions live** and resolves a trip against whichever
version knows it, newest first. That is the difference between four dark days a year and
none, for the cost of a `DISTINCT ON` and three times the schedule rows.

## Service dates, and the two ways to be a day wrong

A service day is not a calendar day. The 00:40 owl bus belongs to the previous day's
schedule, and GTFS says so by letting stop times run past 24:00:00 — `25:12:00` is 01:12
tomorrow *on today's service date*.

`scheduleindex.resolveServiceDate` decides, in order:

1. The producer said so (`start_date` on the trip descriptor). Authoritative.
2. Otherwise, of today and yesterday, whichever service date puts the trip's scheduled start
   closest to when it actually seems to be running. On an ordinary trip today wins by hours;
   at 00:40 the previous service day wins by the same margin. A naive "use today" is wrong
   for six hours every night.
3. Beyond eighteen hours from either candidate, neither explains the trip and it is dropped
   rather than guessed at.

**And the one that does not announce itself.** A service day is measured from *noon minus
twelve hours*, not from midnight — that is the actual wording in the GTFS spec, and it is
not pedantry. On the spring-forward date, midnight-plus-eight-hours is 09:00 local, while
noon-minus-twelve-plus-eight is 08:00 local, which is when the bus actually runs. Two days a
year, an entire region's schedule is an hour wrong if you anchor on midnight, and nothing in
the output looks broken — every trip is simply an hour off in the same direction, which
reads as a bad day for the network rather than a bug.

Noon is used precisely because no jurisdiction shifts its clocks at midday, so the offset
there is unambiguous. All of it lives in `servicedate.ts` and nowhere else, with tests that
assert the spring-forward and fall-back cases by name — including the night that contains
01:12 twice, where GTFS's elapsed-seconds representation distinguishes the two runs and a
clock reading cannot.

## What is refused, and why

Four layers with genuinely different causes, in `outlier.ts`, because collapsing them into
one "is this an outlier" predicate either throws away the most interesting data or averages
in the most misleading.

**Impossible.** A deviation over two hours, an increment over an hour, a negative dwell, a
departure before the previous stop's. These are bugs — in the feed, in the matching, or in
us — counted and dropped, never softened.

**Structurally different.** Cancelled trips, skipped stops, added specials. Not a tail of
the same distribution: a different population wearing the same key. Dropped by rule.

**Genuine incidents.** A crash, a bridge lift, a police hold. Real, and the most interesting
rows in the database — so they are kept whole in the histogram and down-weighted in the mean
by a Huber weight applied as the observation arrives. Trimming does not stream; this gets
most of the robustness for one multiplication and is exactly 1 for every inlying point.

**Whole-window anomalies.** An hour where the agency-wide median deviation exceeds ninety
seconds, or where active trips fall below sixty per cent of the usual for that weekday and
hour. The rows are written and flagged, and excluded from training — one Bay Bridge closure
otherwise argues about every Transbay segment for the next three weeks. The flagged rows are
the incident dataset, which is worth having on its own.

## What we cannot see, and cannot fix

**Selection bias.** A vehicle is only observed while it is reporting, and vehicles stop
reporting *because* something went wrong. The observations we keep are therefore truncated
on the late side, in a way correlated with exactly the thing being measured. No amount of
careful averaging inside the sample detects it.

It cannot be corrected, so it is measured: the fraction of scheduled trips observed end to
end, per agency per day, on `/health`. At 85% it is a rounding error. At 55% with the gaps
skewing late, the profile is describing the buses that had an easy day, and should be read
that way.

## Verifying any of this

`forensics.ts` samples the regional feed and writes `docs/feed-forensics.md`: per agency,
how many trips carry `start_date`, how many vehicles carry `current_status`, how many were
ever seen `STOPPED_AT`, how many trips are the timetable republished as a prediction, and
therefore whether direct observation is available at all.

```
npm run build && node dist/forensics.js 60 30   # 60 samples, 30s apart
```

Two 511 requests per sample. **Run it before believing any tier assignment in this
document** — every σ here is a starting value, and the tier availability per agency is an
empirical question that the answer to changes what the profile is worth.
