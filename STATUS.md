# Where the deployment stands

Written 2026-09-07, ~01:40 Pacific. This is the short-lived file — delete it once the
cutover in [`DEPLOY.md`](DEPLOY.md) is finished. It exists so nobody has to reconstruct the
state from memory.

## Done

| | |
|---|---|
| `transitapi` repo | pushed, `main` at "Delete railway.json" |
| Railway project | **BayTransit Widgets**, all five services in **`us-west2`** |
| `Postgres` | plugin added, migrated to `us-west2`, **schema version 4** |
| `transitapi` | API service, `transitapi-production.up.railway.app`, healthy, **idle** |
| `transitapiStatic` | cron service, `npm run static`, `20 10 * * *`, restart Never |
| Schedule | **built once manually.** 46,613 trips, 1,619,403 stop times, 472 service days, 10.4 s, feed version 1 |
| `railway.json` | deleted — it could not describe both services. Start commands are set per service |
| Variables | copied, plus `POLLED_AGENCIES=*`, `PROFILED_AGENCIES=SF,BA,CT,SM,GG`, `PREDICTION_MODE=shadow` |

`baytransit-widgets` is untouched and still serving the app at `transitapi.transbay.dev`.
It holds the poller lease. Budget was 235/600 in the hour this was written, and **both
services report the same number**, which is the proof that they share Redis and only one of
them is polling.

## The one remaining step

**Hand the poller lease to `transitapi`** by setting `POLL_ENABLED=false` on
`baytransit-widgets`. Within about 45 seconds `transitapi` takes the lease and starts
polling all 24 operators and observing the five profiled ones. The old service keeps
answering `/v1/departures` out of the same Redis, now written by the new code.

### Do it with the logs open, not overnight

`transitapi` has never actually polled in production. The old service sweeps 8 agencies; the
new one sweeps 24, with more Redis writes per cycle. If a cycle overruns the 15-second
interval it trips the overlap guard in `poller.ts`, snapshots go stale, and the app degrades
— and the fix is a variable somebody has to be awake to flip.

One night of observations is worth much less than watching the first few cycles. What to
watch for:

```
[poller] regional: ~9000 visits across ~3000 stops in <2s     <- well under 15s
[schedule] index for YYYY-MM-DD: ~10000 trips                  <- the index loads
```

Then on `/health`, within about ten minutes:

- `profile.schedule.trips` — around 10,000 (today's and yesterday's active trips)
- `profile.learner.leader` — `true`
- `profile.observation.tracker.byTier` — `[A1, A2, B, C, Cu, D]` starting to fill
- `profile.learner.admitted` — climbing, and `rejected` **not** dominated by one reason

If anything looks wrong: set `POLL_ENABLED=true` again and the old service retakes the lease
on its next tick.

## Two readings that look wrong and are not

**`profile.schedule.trips: 0`** while Postgres has 46,613. The in-memory index tried to load
at boot, before the cron had ever run, found nothing and kept an empty index. It reloads on
the first poll cycle after the handover. Not a fault.

**`poll.agencies: []`** on `transitapi`. `/health` reads the agency list from a Redis set
that only this build writes, and this build has not polled yet. Fixed since — it now falls
back to discovering the list from the snapshot keys — but either way it populates itself on
the first cycle. Departures resolve correctly from the existing keys regardless.

## After the handover

Nothing, for about three weeks. `PREDICTION_MODE=shadow` means corrections are computed and
scored but never claimed, and `/analysis/:agency/:route` will say "no profile yet" until
cells have real evidence behind them. That is the design, not a fault — see
[`docs/07-evaluation.md`](docs/07-evaluation.md).

Worth doing in that window:

1. **Re-run the forensics during a daytime peak.** Everything in
   [`docs/feed-forensics.md`](docs/feed-forensics.md) was measured overnight on owl service.
   The availability answers are structural, but the volumes and the tier mix are not.
   `node dist/forensics.js 60 30`, two 511 requests per sample.
2. **Watch `learner.rejected`.** A single reason dominating means a feed pathology, not a
   quiet system. SamTrans publishing day-stale owl predictions and Muni labelling
   `start_date` with the calendar date were both found this way.
3. **Watch `learner.streamDepth`.** Growing means the learner is behind and observations are
   being dropped — the correct trade, and still worth knowing.

## Not done, deliberately

- **`baytransit-widgets` has an unpushed commit** deleting `server/`. Leave it unpushed
  until the app is on the new host — step 8 of `DEPLOY.md`. Pushing it breaks that service's
  next build.
- **`transitapi.transbay.dev` still points at the old service.** Move it once the new one has
  been leading for a while.
- **`ServerEnvironment.swift` still compiles in `baytransit.up.railway.app`**, which belongs
  to the old service and dies with it. That hostname has to keep answering until every device
  that will ever update has updated.
