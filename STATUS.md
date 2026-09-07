# Where the deployment stands

Written 2026-09-07, ~02:00 Pacific, just after the poller lease moved to this service. This
is the short-lived file — delete it once the cutover in [`DEPLOY.md`](DEPLOY.md) is
finished. It exists so nobody has to reconstruct the state from memory.

## Done

| | |
|---|---|
| `transitapi` repo | pushed, `main` at "Record where the deployment stands" |
| Railway project | **BayTransit Widgets**, all five services in **`us-west2`** |
| `Postgres` | plugin added, **schema version 4** |
| `transitapi` | API service, `transitapi-production.up.railway.app`, healthy, **polling and learning** |
| `transitapiStatic` | cron service, `npm run static`, `20 10 * * *` UTC = 03:20 Pacific, restart Never |
| Schedule | 46,613 trips, 1,619,403 stop times, 472 service days, feed version 1 |
| Schedule index | loads on boot, 10,399 trips for 2026-09-07 |
| `railway.json` | deleted — it could not describe both services. Start commands are set per service |
| Variables | `POLLED_AGENCIES=*`, `PROFILED_AGENCIES=SF,BA,CT,SM,GG`, `PREDICTION_MODE=shadow` |
| **Poller lease** | **handed over.** `POLL_ENABLED=false` on `baytransit-widgets` |

## The handover, and why it was safe

`baytransit-widgets` and `transitapi` share one Redis, and both run the same
`LEADER_KEY = 'poller:leader'`. Only one process in that Redis can poll, whatever its API
keys are — so "run both overnight" was never available, and was never needed. Moving the
lease was the whole job.

Verified byte-compatible before flipping it, because the old service still serves the app
out of the keys the new poller now writes:

| | |
|---|---|
| `snapshot.ts` write path | **identical** (only the `/health` read path changed) |
| `siri.ts`, `names.ts` | **0 changed lines** |
| `gtfsrt.ts` | 9 lines, all the nullable agency filter; entry contents identical |

The proof it worked, thirty seconds after the flip: `baytransit-widgets` reports
`poll.enabled: false` while its snapshots are **14 seconds fresh**. It has stopped polling
and is being fed by this service.

### First measurements after the handover

Three learner folds, about eight minutes apart in total:

| | fold 1 | fold 2 | fold 3 |
|---|---|---|---|
| poll cycles | 9 | 26 | 44 |
| events | 127 | 301 | 517 |
| observations folded | 93 | 301 | 510 |
| admitted | 25 (27%) | 188 (62%) | 363 (71%) |
| cells written | 75 | 562 | 1,087 |
| routes published | 0 | 0 | 19 |

Tiers at fold 3: `[A1:21 A2:187 B:41 C:0 Cu:236 D:0]`, activeTrips 164, `lastTickMs: 141`,
`lastError: null`. Postgres confirms it independently: `profileCells: 560+`, `observedDays: 1`,
`failures: 0` — the cells are persisted, not merely counted in memory.

Four things worth reading off that:

- **`noSchedule=0` across all 517 observations.** This is the `Deviation.segmentKey`
  serialisation bug confirmed fixed in production — before it, the learner rejected *every*
  real observation and counted the rejection in silence.
- **Each fold drains the whole stream.** Observations folded tracks events exactly, because
  `drain()` takes up to 5,000 an interval and an interval accumulates about 260.
- **The admission rate climbs, 27% → 62% → 71%**, which is the shrinkage ladder acquiring
  enough evidence per cell to stop deferring entirely to its parent.
- **A1+A2 = 208 of 517**, so 40% of events are direct vehicle observation rather than
  converged predictions — on owl service. That is the answer the whole observation design
  hung on, and it is the good one.

`frozenAgencies` climbing (4 → 17 over eight minutes) is not a fault. At two in the morning
most of the 24 polled operators publish a prediction set byte-identical to the last cycle, and
the suppressor refuses to mint fictional passage events from it. See `docs/03-observation.md`,
"The frozen producer".

`impossible-deviation` is the largest rejection reason (44) but not a dominant one. The
likeliest cause is documented: SamTrans publishes day-stale predictions on its late-night
trips, roughly 24 hours in the past, and every one is correctly refused. Expect this to shrink
once daytime service starts — and if it does not, that is worth a look.

### Infrastructure headroom, measured

| | used | limit |
|---|---|---|
| Redis | 47 MB (disk 57 MB) | 24 GB |
| Postgres | 1.83 GB disk, 234 MB memory | 24 GB |
| `transitapi` | 271 MB, 2.8% CPU | 24 GB |

Nothing here is close to a limit. A full 200,000-entry observation stream is about 60 MB, and
the morning peak is perhaps ten times the overnight volume; both are noise against 24 GB. Cost
is the reason to watch these, not capacity.

Three things worth reading off that:

- **`noSchedule=0`.** Every observation resolved to a schedule. This is the
  `Deviation.segmentKey` serialisation bug confirmed fixed in production — before it, the
  learner rejected *every* real observation and nothing would ever have been learned.
- **A1+A2 = 51 of 127**, so 40% of events are direct vehicle observation rather than
  converged predictions, on owl service. Daytime should be better.
- **`rejected` is spread across three reasons**, none dominant. A single reason dominating is
  the signature of a feed pathology, which is how Muni's `start_date` mislabelling and
  SamTrans's day-stale predictions were both found.

`frozenAgencies: 4` is not a fault. At two in the morning several of the 24 polled operators
publish a prediction set that is byte-identical between cycles, and the suppressor refuses to
mint fictional passage events from it. See `docs/03-observation.md`, "The frozen producer".

## The morning check

```
curl -s https://transitapi-production.up.railway.app/health \
  | jq '.profile | {leader: .learner.leader, obs: .learner.observations,
                    admitted: .learner.admitted, cells: .learner.cellsWritten,
                    tiers: .observation.tracker.byTier, err: .learner.lastError}'
```

Healthy looks like: `leader: true`, `obs` in the thousands, `admitted` a decent fraction of
it, `cells` in the thousands, `tiers` with non-zero A1/A2, `err: null`.

**The two real liveness signals are `observation.tracker.cycles` and `learner.ticks`.** Both
must be advancing. Cycles climb about four a minute; ticks one every five minutes. Everything
else can look odd for innocent reasons, and two of them look alarming:

**`poll.agencies[].ageSeconds` is 511's clock, not ours.** `snapshot.ts` stamps the snapshot
with `grouped.responseTimestamp` — the feed header — and only falls back to our write time if
the producer omits it. So the number measures how old 511's data is. It read 10 s at 01:47 and
33 s at 02:15 with the poller perfectly healthy in between. The tell that it is feed-wide
rather than ours: every agency reports the *same* value to the second, including operators we
barely touch. If it were our write latency it would vary per agency by write order.

Corollary: **never read the maximum age across agencies.** An operator that has stopped for
the night legitimately goes stale — BART sat at 212 s at 2 a.m. with two stops left in its
feed, because BART was shut. Read the freshest, or read `SF`, which is 4:1 the volume of the
other four profiled agencies combined.

**`learner.lastTickMs` is the number that would warn you of a real backlog**, and it was
**141 ms**. A fold that costs a seventh of a second cannot fall behind a 300-second interval.

**Do not read `learner.streamDepth` as a backlog.** It is `XLEN` on the whole stream, capped
at 200,000 by `PROFILE_STREAM_MAXLEN`, so it climbs toward that cap and then sits on it
forever whether the learner is keeping up or not — at roughly 75,000 observations a day it
will be pinned at `200000` within three days, which looks alarming and means nothing.

The learner cannot realistically fall behind: `eventlog.drain()` takes up to 5,000 entries
per tick and a 300-second fold accumulates about 260. If you want the true lag it is
`eventLogStats.appended - drained`, which is **not on `/health` yet** — see the follow-up
list below.

**Rollback is one variable.** Set `POLL_ENABLED=true` on `baytransit-widgets` and it retakes
the lease on its next tick. Nothing in this service can affect `/v1/departures`, which is
still served by the old code from the same Redis.

## Where to actually look in the morning

**The day type is not the calendar day, and this will fool you.** Two separate reasons:

1. **Owl trips belong to the previous service day.** Everything collected between midnight
   and about 5 a.m. on the 7th belongs to service date **2026-09-06, a Sunday** — so it is
   written under `DayType.Sun = 4`. The half-hour buckets read `25:30` and `26:00`, which is
   GTFS for 01:30 and 02:00 *on the Sunday service day*. This is `servicedate.ts` working, not
   a bug.
2. **2026-09-07 is Labor Day.** Muni runs Sunday service, so `warehouse.isHoliday` compares
   today's active `service_id` set against the previous three Mondays, finds it matches none of
   them, and classifies the day as `DayType.Hol = 5`. Today's *daytime* data therefore lands
   under **Holiday**, not Monday.

So `daytype=0` will be empty all day and that is correct. The useful URLs:

```
# tonight's owl service (Sunday service day)
/analysis/SF/14?daytype=4
# today's daytime service (Labor Day)
/analysis/SF/14?daytype=5
```

The page carries `Mon · Tue-Thu · Fri · Sat · Sun · Holiday` links, so clicking through works
too — but the default landing view is Tue-Thu, which will be empty for days.

Confirmed queryable at 02:15, nine Muni owl routes with real structure:

```
SF/91  19th Ave & Holloway/SF State -> 19th Ave & Winston/Stonestown  sched 88s  mean +53s
SF/48  22nd St Caltrain/Iowa -> Pennsylvania Ave & 23rd St            sched 62s  mean -34s
SF/24  Cortland & Andover -> Cortland & Ellsworth                     sched 33s  mean -19s
```

Per-cell `n` still reads "not enough data", which is the honest answer: the cells exist and
the segments are identified, but no individual half hour has the evidence to be trusted yet.

**A consequence worth planning around: today is a holiday, so today is a bad day to judge the
morning peak.** The first ordinary weekday peak is Tuesday the 8th.

## 511 budget, measured

Sampled over three minutes: **exactly 8.0 requests/minute, 480/hour against a 600 limit** —
precisely the `rg`-mode steady state of two requests every fifteen seconds. The 120/hour left
over absorbs on-demand fetches from app traffic.

An earlier reading of "54 used, 9% of budget" five minutes into the hour looked like a 648/hour
overspend. It was the fixed hourly bucket (`Math.floor(Date.now() / 3_600_000)`) having just
rolled over, not a real rate. Worth knowing before anybody else does that arithmetic.

On-demand cannot run away with the budget either: `routes.ts` gates a live fetch behind
`config.poll.hybrid || snapshot === null`, and `hybrid` is false, so a snapshot that is merely
stale by 511's clock is served as-is rather than triggering a fetch. Only a stop with no
snapshot at all spends a request.

## Expect no profiles for about three weeks

`PREDICTION_MODE=shadow` means corrections are computed and scored but never claimed, and
`/analysis/:agency/:route` will say "no profile yet" until cells have real evidence behind
them. One night of owl service is enough to prove the pipeline, not to describe a corridor.
That is the design, not a fault — see [`docs/07-evaluation.md`](docs/07-evaluation.md).

Worth doing in that window:

1. **Re-run the forensics during a daytime peak.** Everything in
   [`docs/feed-forensics.md`](docs/feed-forensics.md) was measured overnight on owl service.
   The availability answers are structural, but the volumes and the tier mix are not.
   `node dist/forensics.js 60 30`, two 511 requests per sample.
2. **Re-check `implausible-speed`.** 13 rejections in the first nine cycles, and the earlier
   overnight sample had 22 at a 120-second cadence. At 15 seconds the threshold may be
   tuned for the wrong cadence.
3. **Watch the tier mix in daylight.** If A1+A2 stays near 40% the prediction-error model can
   be trained without circularity for the bus operators.
4. **Put the real learner lag on `/health`.** `eventLogStats` already tracks `appended` and
   `drained`; their difference is the actual backlog and nothing exposes it. Deliberately not
   done tonight, because deploying it restarts the poller and resets every in-memory counter
   — `tracker.cycles`, `events`, `byTier` — which is exactly the overnight evidence this
   handover was for. Ship it with the next deploy in daylight.

## Not done, deliberately

- **`baytransit-widgets` has an unpushed commit** deleting `server/`. Leave it unpushed
  until the app is on the new host — step 8 of `DEPLOY.md`. Pushing it breaks that service's
  next build, and that service is still the one answering the app.
- **`transitapi.transbay.dev` still points at the old service.** Move it once this one has
  been leading for a while.
- **`ServerEnvironment.swift` still compiles in `baytransit.up.railway.app`**, which belongs
  to the old service and dies with it. That hostname has to keep answering until every device
  that will ever update has updated.
