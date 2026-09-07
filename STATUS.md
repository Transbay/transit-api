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

```
cyc=9  ev=127  tiers=[A1:17 A2:34 B:14 C:0 Cu:62 D:0]  activeTrips=151
dev=127  noSchedule=0
tick=1  obs=93  admitted=25  cellsWritten=75
rejected={implausible-speed:13, impossible-deviation:15, trip-start:2}
```

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

Read `learner.streamDepth` too. Growing without bound means the learner is behind and
observations are being dropped — the correct trade, and still worth knowing.

**Rollback is one variable.** Set `POLL_ENABLED=true` on `baytransit-widgets` and it retakes
the lease on its next tick. Nothing in this service can affect `/v1/departures`, which is
still served by the old code from the same Redis.

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

## Not done, deliberately

- **`baytransit-widgets` has an unpushed commit** deleting `server/`. Leave it unpushed
  until the app is on the new host — step 8 of `DEPLOY.md`. Pushing it breaks that service's
  next build, and that service is still the one answering the app.
- **`transitapi.transbay.dev` still points at the old service.** Move it once this one has
  been leading for a while.
- **`ServerEnvironment.swift` still compiles in `baytransit.up.railway.app`**, which belongs
  to the old service and dies with it. That hostname has to keep answering until every device
  that will ever update has updated.
