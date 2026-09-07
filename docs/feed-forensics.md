# Feed forensics

What the 511 feed actually contains, measured rather than assumed.

Two halves. The **static** half below was measured against the real regional archive on
2026-09-06 and is complete. The **realtime** half is not yet done and is the decision gate
for the observation design — run `node dist/forensics.js 60 30` and this file will be
rewritten with it.

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

## Realtime feed — not yet measured

**This is the decision gate for [`03-observation.md`](03-observation.md), and until it is
run, every tier assignment in that document is a design assumption.**

The questions, and what each one decides:

| Question | Decides |
|---|---|
| Do `VehiclePosition`s carry `current_status` and `current_stop_sequence`? | Whether **direct observation exists at all**. Without it every actual time is inferred from a prediction, and the prediction-error model cannot be trained without circularity |
| Is any vehicle ever seen `STOPPED_AT`? | Whether dwell is measurable, and whether tier A1 exists as opposed to only A2 |
| Does `TripDescriptor` carry `start_date` / `start_time`? | Whether service dates are read or inferred. The failure mode of inferring is a whole day of error |
| What fraction of realtime `trip_id`s match the archive? | How much fallback matching is needed, and how bad service-change weeks are |
| Are `arrival` and `departure` both populated? | Whether dwell is separable from running time |
| Is `schedule_relationship` used? | Whether cancellations and skipped stops are visible, or silently become fake observations |
| How often is a trip's prediction identical to its schedule? | Whether a producer is republishing the timetable and calling it realtime |
| What is the median gap between distinct `vehicle.timestamp` values? | The real σ for the A tiers. We sweep every 15 s, but a vehicle reporting every 45 s is not observed to 15 s |

Expected outcome for BART: no positions anywhere, so tiers A and B unavailable and its
history built entirely on inferred times. Its own ETD API publishes a `Leaving` flag whose
accuracy is already characterised in this codebase (−84 s to +81 s, median +12 s) and a
`delaySeconds` field that is a direct statement of schedule deviation — both better than
inference, and both worth wiring in before trusting any BART segment profile.

```
npm run build && node dist/forensics.js 60 30
```

Two 511 requests per sample; sixty samples thirty seconds apart is half an hour and 120
requests of a 600/hour budget.
