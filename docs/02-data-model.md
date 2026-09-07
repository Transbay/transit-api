# Data model

Two stores, with a clear division: **Postgres is the warehouse, Redis is the hot path.** The
serving side never learned how to talk to Postgres, which is what lets predictions keep
working while it is down, being reindexed, or absent entirely.

## Postgres

Migrations are plain numbered `.sql` files in `migrations/`, applied at boot by a runner in
`warehouse.ts` and recorded in `schema_version`. No ORM: this codebase writes its own Redis
commands and its own SQL, and the queries here are analytical rather than CRUD.

### Schedule

```sql
feed_version(id, loaded_at, agencies[], trips, stop_times, active)

scheduled_trip(feed_version, agency, trip_id, route_id, direction_id, pattern_id,
               service_id, block_id, short_name, start_s,
               stop_ids[], seqs[], arrivals[], departures[], timepoints[])

service_day(feed_version, agency, service_id, day)
```

One row per trip, with the stop sequence as parallel arrays rather than a `stop_times`
table. Nothing ever asks for one stop time in isolation — the read is always "give me this
whole trip" — and a normalised table would be 400,000 rows per feed version to answer a
query that is naturally one row.

Times are **seconds into the service day**, never timestamps. `25:12:00` is 90720, and stays
90720 across a DST boundary that a stored timestamp would silently move.

**Three versions are kept live.** When 511 ships a service change the realtime feed moves
hours before the archive does, and trips appear that the newest tables have never heard of.
Resolving against whichever version knows a trip is the difference between four dark days a
year and none. `loadTripsFor` does `DISTINCT ON (trip_id) ... ORDER BY feed_version DESC`.

### Observations

```sql
trip_observation(service_date, agency, trip_id, route_id, direction_id, pattern_id,
                 block_id, vehicle_id,
                 seqs[], stop_ids[], sched_dep[], act_dep[], act_arr[],
                 dev_dep[], delta[], tiers[], held[],
                 pred_err[], anomalous, written_at)
  PARTITION BY RANGE (service_date)
```

Again one row per trip-instance rather than per stop event, and this is where it matters
most. Per stop event that is roughly 300,000 rows a day, 27 million a quarter, and with two
indexes it costs more in index than in data — about 4.5 GB. As arrays it is **625,000 rows a
quarter and around 340 MB**, one index, and the read unit matches how it is actually used:
this table exists for replay and forensics, and the aggregate tables answer every analytical
query.

Rows are assembled in memory and written once when a trip goes quiet, not upserted per stop.
A forty-stop trip observed over ninety minutes would otherwise rewrite a growing row forty
times, and nothing reads a partial trip.

`delta[]` uses an explicit sentinel where there was no prior stop. `pred_err[]` is flattened
`(horizon, error)` pairs, and a horizon nobody watched is **absent rather than zero** —
reading an unobserved horizon as a perfect prediction would flatter the agency's predictor
exactly where we know least about it.

**Partitioned by day.** Retention becomes `DROP TABLE`, which is a catalogue update.
Deleting eight million rows is an afternoon of vacuum and a table that never gives the disk
back.

### Profiles

```sql
segment_profile(agency, route_id, direction_id, segment_key, day_type, bucket,
                n, mean, m2,
                reg_w, reg_sx, reg_sy, reg_sxx, reg_sxy,
                scheduled_run, noise_var, histogram, updated_at)

corridor_profile(agency, corridor_key, day_type, bucket, n, mean, m2)
route_profile(agency, route_id, direction_id, day_type, bucket, n, mean, m2)
agency_profile(agency, day_type, bucket, n, mean, m2)
start_profile(agency, route_id, direction_id, day_type, bucket, n, mean, m2)
prediction_error(agency, route_id, direction_id, horizon, day_type, bucket, n, mean, m2)
tier_calibration(agency, period, n, offset_s, variance)
model_score(day, agency, horizon, n, raw_mae, raw_median, corr_mae, corr_median,
            bias, coverage, win_rate)
```

`day_type = -1` and `bucket = -1` mean "pooled at this level", which is what lets one table
hold every rung of the ladder instead of one table per rung.

`histogram` is populated only where `day_type` is set and `bucket = -1`. Tail shape is a
property of a segment and a day type and does not vary meaningfully between adjacent half
hours; storing it per bucket would be a gigabyte of the same curve written sixty times.

`scheduled_run` is on the row so a timetable change can **re-base** a cell rather than
discard it. `noise_var` is the mean measurement variance behind the cell, so the reported
spread can have the instrumentation subtracted out.

Profiles are written as a **whole replace**, never an increment. The learner holds the
authoritative copy for the duration of a tick and this is a checkpoint of it. Incrementing
in SQL would make two learners racing each other double-count, and the resulting inflation
of `n` has no symptom at all.

The five pooled tables share one read-modify-write path (`loadMoments` / `saveMoments`)
against a whitelist of table and column names — the only safe way to interpolate an
identifier into SQL is not to.

### Sizing

| | |
|---|---|
| Stop events/day, five agencies | ~250,000–300,000 (Muni is ~4:1 over the rest combined) |
| Trip rows/day | ~7,000 |
| Trip rows, 90 days | ~630,000, ~340 MB with its index |
| Schedule rows | ~48,000 per version × 3 versions |
| Profile cells at maturity | 1–4 million |
| **Provision** | **10 GB**, expecting 2–4 used |

Retention: raw observations 90 days by daily partition, profiles indefinitely. The profile
is the durable artefact; if the observation table were lost, three months of learning would
still be here.

## Redis

| Key | Contents | TTL |
|---|---|---|
| `511:snap:<agency>` | departures by stop code | 6 × poll interval |
| `511:snap:agencies` | which agencies we have actually written | — |
| `511:veh:<agency>` | vehicle positions | 6 × poll interval (90 s if synthesized) |
| `gtfs:trip`, `gtfs:stop` | name tables | — |
| `gtfs:bart:*` | BART geometry | — |
| `poller:leader` | the lease. The learner shares it | ~3 cycles |
| `obs:stream` | the observation stream | capped at `PROFILE_STREAM_MAXLEN` |
| `obs:cursor` | the learner's position in it | — |
| `live:block:<agency>:<date>:<key>` | today's vehicle bias | 8 h |
| `pred:<agency>` | raw departures by stop, with trip identity | 6 × poll interval |
| `prof:<agency>:<route>:<dir>:<daytype>` | the packed profile | **none** |

### The packed profile blob

```
u8   version
u16  segment count
  per segment:
    u16  key length, then the key ("<fromStop>><toStop>" with an occurrence suffix)
    u16  scheduled run, seconds
    i16  slope x 1000
    i16  all-time mean, seconds
    u16  all-time effective count
    u16  all-time sd, seconds
    60 x { i16 mean | EMPTY, u8 count, u8 sd/4 }
```

About 300 bytes per segment; ~15 KB for a fifty-segment route; on the order of 50 MB for
everything. `EMPTY` is `-32768`, distinguishable from a bucket whose mean is genuinely zero.
The sd is stored at quarter-second resolution, which is far finer than the uncertainty in it
and saves a byte per bucket across millions of them.

**Why not one hash field per cell.** Roughly 110 bytes of Redis overhead *per field*: across
a few million populated cells that is most of a gigabyte of key metadata to store a few tens
of megabytes of numbers. And predicting one trip becomes forty round trips where this is
one. Getting this backwards is the easiest way to blow the Redis plan, so it is written down
here.

A blob written by an older build is **discarded rather than misread** — the aggregator
rewrites everything within one cycle, so the cost of a version bump is minutes. A blob that
arrives short stops at the last whole segment rather than throwing inside a poll cycle.

Readers hold an in-process cache keyed on a version stamp, checked at most every 30 seconds
— the same pattern `loadBartGeometry` has always used, for the same reason.

### The event stream

The durable hand-off, and what makes the warehouse genuinely optional rather than optional
in principle. The poller appends and never waits; the learner drains on its own timer.
Postgres down costs history, not availability; Redis down costs history, not departures.

The cap is the rule *"losing history is preferable to delaying a departure"* written as a
number. When the learner falls behind, the oldest observations are dropped and
`learner.streamDepth` on `/health` says so. That is a bad day for the profile and an
ordinary one for everybody using the app.

Field names in the stream are two characters. A quarter of a million entries a day at forty
bytes of key names apiece is ten megabytes a day of field names — in a capped stream, that
is entries evicted for nothing.
