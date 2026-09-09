# Overview

## The idea

This service already fetches, every fifteen seconds, a complete set of predictions for
every transit vehicle in the Bay Area. It uses them to answer "when is my bus coming" and
then throws them away.

Fifteen seconds later it fetches them again, and can see how each one moved.

Recorded over months, that is a map of exactly where and when each line loses time and
where it makes it back. The 172 running seventeen minutes ahead of its timetable into
Copeland on a Friday morning. The segment where an inbound N always sheds two minutes
because the tunnel meters it. The driver who has been running hot since six.

None of that is currently written down anywhere, by anyone. Agencies publish predictions;
almost nobody keeps the record of whether they were right.

## What comes out of it

**A better prediction.** The agency's number, corrected by what that segment does at that
hour on that day, and by what this particular vehicle has been doing all shift.

**A prediction where there was none.** A trip beyond the realtime horizon currently gets
its timetable. With a profile it gets the timetable plus what actually happens to trips
like it — which for an operator that habitually runs four minutes early is a materially
different answer.

**The pattern itself.** Where delay accrues and where it is recovered, as something you can
query and look at. This is the part that is interesting on its own, separately from any
prediction, and it is the part nobody publishes.

## The one rule

> **The laboratory must never be able to break the factory.**

The live departures path — poller, snapshot, `/v1/departures` — behaves identically whether
the warehouse is up, down, empty or absent. Not "degrades gracefully": *identically*. The
historical system is a strict addition, and every piece of it is wrapped the way `poller.ts`
already wraps BART geometry: its own try/catch, its own counters, never on the path of a
response.

Two things follow from that rule, and both are load-bearing:

1. **`/v1/departures` is not touched.** It serves the agency's raw times in the SIRI
   envelope, byte-compatible with builds that have been on people's phones for months.
   Corrections live on `/v1/predictions`, a new endpoint. That is not timidity — it means
   no change here can reach a widget by accident, and the contract tests on the iOS side
   stay green by construction rather than by care.
2. **The failure mode is silence.** A Postgres outage costs history, not availability.
   Which is its own hazard, because nobody notices silence — so every failure increments a
   counter that `/health` reports, and those counters are the thing to alert on.

## Scope

**Served:** every operator the 511 regional feed carries, roughly two dozen. This costs no
extra requests — both protobufs already contain all of them.

**Segment-profiled:** Muni (SF), BART (BA), Caltrain (CT), SamTrans (SM), Golden Gate
Transit (GG). Five, because storing a stop-level event for every vehicle at every stop all
day is not free. Widening this is planned and staged; the binding constraint is Redis
memory for the hot profile blobs, not Postgres.

**Drift-profiled: all of them.** How far each operator's own predictions move as an arrival
closes is measured for every agency in the feed, because that measurement needs no schedule
and no observation pipeline — only the trip-update stream — and so costs nothing per extra
operator. See [`drift.ts`](../src/drift.ts). It is what catches a producer whose countdown
reliably slips twenty seconds in the last half minute, which the segment model cannot see:
that model compares vehicles against the timetable and never looks at what the agency said.

**Cost against the 511 budget: zero.** The whole historical system learns from bytes we
already pay for. The only new upstream cost is parsing more of the archive we already
download once a day — CPU and memory, not requests.

## The shape of it

```
                    511 regional feed  (2 requests / 15s, all 24 operators)
                              |
                    +---------+---------+
                    |                   |
              [ gtfsrt.ts ]        [ rtdecode.ts ]        <- decoded twice, on purpose
             SIRI translation      raw fields, unshaped
                    |                   |
              [ snapshot ]         [ observe.ts ]   trip state across cycles
                    |                   |
            /v1/departures         [ deviation.ts ]  actual - scheduled, per segment
             (unchanged)                |
                                  [ eventlog ]   Redis stream, capped, never blocks
                                        |
                                  [ learner.ts ]   every 5 min, leader only
                                        |
                              +---------+---------+
                              |                   |
                        [ Postgres ]        [ Redis blobs ]
                        the warehouse       the hot profile
                              |                   |
                        /analysis/*         [ predict.ts ]
                        /v1/profile/*             |
                                            /v1/predictions
```

The two decode paths are the part that looks like duplication and is not. `gtfsrt.ts`
shapes the feed for the app; `rtdecode.ts` reads it raw for the model. Keeping them
separate is the **learning firewall**: the model trains on what the agency published, never
on anything this service has shaped, filtered or corrected. A learner fed its own output
drifts into agreeing with itself, and a model that scores beautifully while predicting
badly is among the hardest kinds of wrong to notice.

## Where the difficulty actually is

Not in the statistics. In the observation.

**GTFS-Realtime never says when a bus left.** It says when a bus *will* leave, repeatedly,
and then stops mentioning the stop. Every claim this system makes rests on inferring an
event that was never published, and the quality of that inference varies by operator, by
time of day, and by which fields a producer happens to set.

So observations are tiered, every one carries the tier it came from and the uncertainty
that tier deserves, and nothing averages across tiers silently. The most important
consequence: an observation inferred from a *prediction* cannot be used to grade a
predictor, because that measures how fast it converges on itself rather than whether it was
right. [`03-observation.md`](03-observation.md) is the document to read before any of the
others.

## Reading order

| | |
|---|---|
| [`01-architecture.md`](01-architecture.md) | which module owns what, and how the rule above is enforced |
| [`02-data-model.md`](02-data-model.md) | every table and key, with sizes |
| [`03-observation.md`](03-observation.md) | **read this one first** — how "actual" times are inferred |
| [`04-delay-profiles.md`](04-delay-profiles.md) | the statistical model |
| [`05-prediction.md`](05-prediction.md) | turning the model into a time |
| [`06-block-state.md`](06-block-state.md) | today's vehicle, as distinct from history |
| [`07-evaluation.md`](07-evaluation.md) | how we would know if any of this works |
| [`08-api.md`](08-api.md) | endpoints |
| [`09-operations.md`](09-operations.md) | deploying and running it |
| [`10-migration.md`](10-migration.md) | what moved from `baytransit-widgets` |
| [`11-roadmap.md`](11-roadmap.md) | what is deliberately not built yet |

## Honest expectations

**It takes about three weeks to be worth anything.** A busy Muni segment collects roughly
eighteen observations a week into any one day-type-and-half-hour cell, and after the design
effect (§[04](04-delay-profiles.md)) the honest count is well under half that. Until then
almost every estimate is its parent's, which is correct behaviour and looks like doing
nothing.

**BART will take much longer.** It publishes no vehicle positions anywhere, so its
observations are the weakest tier and count for a fraction of a direct sighting. Its value
here is the block model and the terminal-layover model, not the segment profile.

**Some of this may not beat the agency at short horizons.** Two minutes out, the operator
has a vehicle two hundred metres away and we have a histogram. The evaluation is designed
to find that out per agency and per horizon rather than to assume it either way, and to say
so plainly when it happens.
