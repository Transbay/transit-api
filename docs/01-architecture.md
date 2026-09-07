# Architecture

## The rule, and how it is enforced

> The laboratory must never be able to break the factory.

Stated as invariants, each of which is a thing in the code rather than an intention:

| Invariant | Enforced by |
|---|---|
| No response waits on Postgres | `warehouse.ts` is called only from `learner.ts` and the schedule build, both on timers. Every function returns an empty result rather than throwing |
| No poll cycle waits on the learner | The poller appends to a Redis stream and returns. The learner drains on its own timer |
| No poll cycle waits on Postgres | Same. The stream is the boundary |
| A throw in observation costs nothing | `observeCycle` has its own try/catch in `pollRegional`, beside the one that already wraps BART geometry, for the same reason |
| `/v1/departures` cannot change | Corrections are computed in `predictions.ts`, which the departures handler does not import |
| The model cannot train on its own output | `rtdecode.ts` and `gtfsrt.ts` are separate modules with no imports between them |

The last two are structural rather than disciplined. A future refactor that breaks them has
to delete a file boundary to do it, which is the point.

## Module map

Modules inherited from the original server, unchanged in job:

| File | Job |
|---|---|
| `index.ts` | Boots Fastify, binds the port, shuts down cleanly |
| `config.ts` | Reads every environment variable, once, and fails loudly if one is missing |
| `routes.ts` | The endpoints; validates query params |
| `auth.ts` / `attest.ts` | Session tokens, and proving a caller is a genuine build of the app |
| `cache.ts` | Read-through cache, request coalescing, stale fallback |
| `keypool.ts` / `upstream.ts` | The 511 budget, and the one place a key is held |
| `poller.ts` | The 15-second sweep and the nightly archive refresh |
| `gtfs.ts` | Turns the static archive into name tables |
| `gtfsrt.ts` | Decodes the regional protobuf and re-emits SIRI |
| `names.ts` | Route badges and simplified destinations |
| `snapshot.ts` | Per-agency stop index and vehicles, in Redis |
| `geo.ts` | Polyline maths. Pure |
| `bart*.ts` | BART's own APIs, ETD enrichment, position synthesis, the verification board |

New, and the shape of the second half:

| File | Job | Pure |
|---|---|---|
| `servicedate.ts` | All GTFS time algebra. Service days, DST, `25:12:00`, buckets, day types | ✓ |
| `stats.ts` | Decayed moments, Huber weighting, shrinkage, streaming regression, histograms | ✓ |
| `schedule.ts` | Trip and segment identity; the in-memory index | ✓ |
| `observe.ts` | The tracker. Feed cycles in, observations out | ✓ |
| `deviation.ts` | Observations plus schedule into increments; timepoint censoring | ✓ |
| `outlier.ts` | The four admission gates | ✓ |
| `profile.ts` | Cells, the shrinkage ladder, the packed hot form | ✓ |
| `blockstate.ts` | Same-day vehicle bias, layover absorption, bunching | ✓ |
| `predict.ts` | Estimators, inverse-variance fusion, the clamps | ✓ |
| `rtdecode.ts` | The raw feed, decoded for the learner and nothing else | ✓ |
| `schedulefeed.ts` | Streaming `stop_times.txt` and the calendar into the warehouse | |
| `scheduleindex.ts` | Today's schedule in memory; service-date resolution | |
| `warehouse.ts` | Postgres: migrations, partitions, every read and write | |
| `eventlog.ts` | The Redis stream between poller and learner | |
| `profilestore.ts` | The packed hot profile in Redis | |
| `learner.ts` | Folds observations into the profile; publishes blobs | |
| `predictions.ts` | The prediction index and `/v1/predictions` | |
| `analysis.ts` | The heatmap and the profile query endpoints | |
| `index.static.ts` | The nightly schedule build, as its own process | |
| `forensics.ts` | Measures what the feed actually contains | |

Nine of the eighteen new modules are pure functions of their arguments — no Redis, no
config, no clock but the one passed in. That is not a stylistic preference: a state machine
with as many corner cases as `observe.ts` is only testable at all if the state goes in and
comes back out, and `observe.test.ts` exercises twenty-one of them against literals.

The layout stays flat, matching the existing `src/`. Forty-odd files is a lot for one
directory, but the names are unambiguous and splitting them would have meant renaming
half the originals for symmetry.

## The two decode paths

```
                    tripupdates protobuf
                     /                \
        gtfsrt.ts                      rtdecode.ts
   SIRI translation                    raw fields
   simplified names                    start_date, schedule_relationship,
   destination cleanup                 current_status, stop_sequence
        |                                    |
   snapshot.ts                          observe.ts
        |                                    |
  /v1/departures                        the profile
```

They never meet. `gtfsrt.ts` exists to make the feed look like what the app already reads;
`rtdecode.ts` exists to preserve exactly the fields that translation discards. Decoding the
same bytes twice costs a few milliseconds a cycle and buys a guarantee: **the model trains
on what the agency published, never on anything this service shaped.**

A learner fed its own output drifts into agreeing with itself. The symptom is a model that
scores beautifully and predicts badly, which is among the hardest kinds of wrong to notice —
so the firewall is a file boundary, and `07-evaluation.md` says what would have to be true
to relax it.

## The cycle, in order

Every fifteen seconds, in the leader instance only:

1. Fetch `tripupdates` and `vehiclepositions` for the whole region. **Two requests.**
2. `gtfsrt.groupTripUpdates` → per-agency, per-stop SIRI visits → `writeSnapshot`.
   *This is the entire live path. Everything below is optional.*
3. BART: ETD enrichment, position synthesis. Unchanged.
4. `rtdecode` the same buffers, filtered to the five profiled agencies.
5. `predictions.writeIndex` — the parallel index `/v1/predictions` reads.
6. `observe.ingest` — diff against last cycle's state, emit observations.
7. `deviation.from` — join to the schedule, compute increments.
8. `eventlog.append` — one pipelined `XADD` batch. Fire and forget.

Steps 4–8 sit inside one try/catch. Measured cost: tens of milliseconds.

Every five minutes, leader only:

9. `learner.tick` — drain the stream, admit or reject, read the affected cells from
   Postgres, update, write back, update block state, accumulate trip rows.
10. `learner.publish` — rebuild the Redis blob for any route whose cells moved.

Nightly, as a separate process:

11. `index.static` — download the archive, stream `stop_times.txt` for five agencies into
    the warehouse, expand the calendar, activate the version, roll partitions. **One
    request.**

## Where state lives

| State | Where | Survives restart | Survives Redis loss |
|---|---|---|---|
| Departure snapshots | Redis | ✓ | rebuilt in one cycle |
| Trip tracker (last cycle's predictions) | process memory | ✗ | ✗ |
| Deviation tracker (last stop per trip) | process memory | ✗ | ✗ |
| Observation stream | Redis, capped | ✓ | lost |
| Block state | Redis, 8h TTL | ✓ | lost |
| Hot profile blobs | Redis, no TTL | ✓ | rebuilt from Postgres |
| Profile cells | Postgres | ✓ | ✓ |
| Trip observations | Postgres, partitioned | ✓ | ✓ |
| Schedule | Postgres, in memory per day | ✓ | ✓ |

The two in-memory trackers are deliberate. Rebuilding them costs one cycle — the first stop
observed on each trip afterwards simply has no increment — and persisting them would put a
2,600-entry write inside the hot path every fifteen seconds to save something that is worth
almost nothing.

The hot profile blobs have **no TTL**, which is a decision rather than an oversight. A
profile is the durable artefact of months of observation, and an expiring one would silently
degrade predictions on any route quiet enough not to be rewritten — exactly the routes that
most need their history.

## Two instances

Railway can run more than one. The poller elects a leader through a short Redis lease,
renewed each cycle, and the learner **shares that lease rather than taking its own**.

Two elections could converge on two different instances, and two learners doing
read-modify-write on the same profile cells double-count with no symptom whatsoever: every
cell simply shrinks less than it should, everywhere, forever. Nothing in the output looks
wrong. That is why the lease is shared rather than duplicated, and why the integration test
has to hold it explicitly rather than the gate being loosened for testing.

## Cost

| | Requests/hour | Notes |
|---|---|---|
| Regional sweep at 15 s | 480 | unchanged; covers every operator |
| Static archive | 1/day | unchanged |
| Schedule build | 1/day | **the entire historical system's upstream cost** |
| BART ETD | 0 | not against the 511 budget |
| Everything else | 0 | learns from bytes already paid for |

Against a ten-key budget of 600/hour. The historical half is free in request terms and costs
CPU, memory and a Postgres instance instead.
