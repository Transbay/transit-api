# Feed forensics

What the 511 feed actually contains, measured rather than assumed.

Both halves measured. The **static** half against the real regional archive on 2026-09-06;
the **realtime** half against the live feed overnight on 2026-09-07, by running the whole
pipeline for an hour rather than by sampling.

Between them they corrected five things the design had wrong, three of them in code that
looked correct and passed its tests. Each correction is marked below.

---

## Static archive — measured

One `datafeeds?operator_id=RG` request, parsed for the five profiled agencies.

| | |
|---|---|
| Parse time | **9.1 s** |
| Trips | **46,613** |
| Stop times | **1,619,403** |
| Service days expanded (±21 days) | 433 |
| Trailing HTML trimmed from the archive | 680 bytes |

| Agency | Trips | Stop times |
|---|---|---|
| SF (Muni) | 34,668 | 1,301,950 |
| SM (SamTrans) | 6,082 | 224,801 |
| BA (BART) | 4,417 | 57,186 |
| GG (Golden Gate) | 1,186 | 29,999 |
| CT (Caltrain) | 260 | 5,467 |

Muni is about 4:1 over the other four combined, which is worth remembering whenever a
number is quoted "across the five agencies" — it is mostly a statement about Muni.

### Assumptions confirmed

**`trip_id` is the first column of `stop_times.txt`.** The whole streaming design rests on
this: the prefilter tests the raw line before it is split, and the reader warns and falls
back to parsing every row if the column is not where it expects. It did not warn.

**`stop_times.txt` is ordered by trip.** Emit-on-trip-change produced zero out-of-order
trips, so at no point is more than one trip plus one write batch resident.

**Times past 24:00:00 are present and parse correctly.** 2,286 trips end after midnight —
SF 1,886, BA 237, SM 118, GG 30, CT 15. Spot check: `SF:12117090` starts at 89,760 s
(24:56:00) and ends at 91,620 s (25:27:00), stored as service-day seconds, on the *previous*
service date. Handled by `parseGtfsTime` and verified by `servicedate.test.ts` against the
2026 DST boundaries.

### Assumptions corrected

**`timepoint` is meaningless on rail, and this changed the code.**

| Agency | Share of stops flagged `timepoint = 1` |
|---|---|
| BART | **100%** |
| Caltrain | **100%** |
| SamTrans | 37% |
| Golden Gate | 21% |
| Muni | 19% |

Two operators flag every stop. Taken at face value that would clamp every BART and Caltrain
prediction to no-earlier-than-schedule, so no train would ever be predicted ahead of its
timetable anywhere — false, and from outside indistinguishable from a punctual railway.

`timepointsAreInformative` now treats a route flagging more than 90% of its stops as having
said nothing. The observed split is clean (rail at 1.00, every bus operator under 0.40), so
the threshold is not doing delicate work.

**BART and Caltrain publish no `block_id` at all.** 0 of 4,417 and 0 of 260. Muni, SamTrans
and Golden Gate populate it on every trip.

The same-day model falls back to `vehicle_id` for those two, and the terminal-layover model
is simply unavailable — it needs a block to know which trip follows which. That is a real
gap on exactly the two operators with the longest trips and the most scheduled turnaround.
Recovering it by chaining observed trips on vehicle id is in
[`11-roadmap.md`](11-roadmap.md).

**Zero-length scheduled segments were not found** in Muni or SamTrans. The
`SEGMENT_MIN_RUN` floor stays — it costs nothing and a rate model divided by zero produces
infinity — but it is defensive rather than load-bearing.

---

## Realtime feed — measured

Sampled from the live regional feed on 2026-09-07 between 00:20 and 01:00 Pacific, so these
are **overnight** figures: owl service only, and a fraction of the daytime fleet. The
availability answers are structural and will not change with the hour; the volumes will.

| Agency | Trips | Vehicles | `current_status` set | Ever `STOPPED_AT` | **Tier A** | `start_date` | `stop_sequence` | arr **and** dep |
|---|---|---|---|---|---|---|---|---|
| SF (Muni) | 445 | 227 | 223 | 92 | **yes** | all | yes | no |
| SM (SamTrans) | 20 | 20 | 2 | 2 | marginal | all | yes | rarely |
| GG (Golden Gate) | 6 | 6 | 6 | 3 | **yes** | all | yes | no |
| BA (BART) | 42 | **0** | 0 | 0 | no | none | none | **yes** |
| CT (Caltrain) | 6 | **0** | 0 | 0 | no | none | none | **yes** |

### The headline

**Direct observation exists for the bus operators.** Muni populates `current_status` on 98%
of its vehicles and they are genuinely seen stopped. That was the open question the whole
observation design hung on, and the answer is the good one: Muni's history will be built on
vehicles reporting themselves rather than on predictions converging, and its
prediction-error model can be trained without circularity.

Observed tier mix over the sample: **15 A1, 58 A2, 73 B, 132 Cu** — so about a third of
observations were position-derived even at a two-minute poll cadence. In production at
fifteen seconds the A tiers should dominate, because tier Cu only arises when a stop leaves
the feed between two sweeps.

SamTrans is the awkward one: it publishes vehicles, but only 2 of 20 carried a status. Worth
re-measuring during the day before concluding anything.

### Rail and bus are complementary, and neither is complete

| | Buses (SF, SM, GG) | Rail (BA, CT) |
|---|---|---|
| Vehicle positions | yes | **none** |
| `current_status` | yes | n/a |
| `stop_sequence` | yes | **none** |
| `start_date` | yes | **none** |
| Both arrival and departure | **no** | yes |
| `block_id` in the archive | yes | **none** |

So rail gives measurable dwell and nothing else; buses give everything except dwell. Neither
gap is fatal, but they are different systems and the tier weights already say so.

### Two producer pathologies, both found by running it

**Muni publishes `start_date` as the calendar date, not the service date.** An owl trip
running at 00:25 on the 7th belongs to the 6th's service day — its stop times are past
24:00:00 — but Muni labels it `20260907`. Taken at face value that puts the scheduled time a
day late and the deviation off by exactly 86,400 seconds.

Measured before the fix: **599 of 976 Muni observations rejected as impossible.** Most of an
operator's overnight service, every night. After treating `start_date` as a hint and
preferring whichever candidate date actually explains when the trip is running: **8**, and
490 dates corrected per sample. `scheduleIndexStats.declaredDateOverridden` counts it, so a
change upstream is visible rather than silent.

**SamTrans publishes day-stale predictions on its late-night trips.** Predicted departures
around 24 hours in the past — verified against the SIRI path in the same process on the same
bytes, so it is the feed and not the decode. Every one is refused by the plausibility gate,
which is the gate working. Also worth knowing that the old server serves those to the app as
"expected departure", where they land in the past and get filtered client-side: harmless
there, poison for a learner.

### What has not been measured yet

- **Daytime volumes and tier mix.** Everything above is overnight. Re-run during a peak.
- **The trip-id match rate during a service change.** Nothing was unmatched in this sample,
  which only means no service change was in flight.
- **The median gap between distinct `vehicle.timestamp` values**, which is the real σ for the
  A tiers. The values in `observe.ts` are still assumptions.
- **Schedule passthrough.** Zero in this sample. Worth re-checking during the day, when a
  producer with nothing live to say has more opportunity to republish the timetable.

```
npm run build && node dist/forensics.js 60 30
```
