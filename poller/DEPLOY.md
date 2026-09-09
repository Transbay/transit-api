# Deploying transitapi to Railway

Written against your actual setup, read from the Railway API on 2026-09-07.

## Short answer

Yes, you need to deploy something new — the code lives in a different repository now, and
Railway builds from a repository. But **you do not need to touch the running service to do
it**, and the safest path is not the obvious one.

## What you have today

| | |
|---|---|
| Workspace | `transbay.dev` |
| Project | **BayTransit Widgets** |
| Services | `baytransit-widgets`, `Redis` |
| Builds from | `WatoBato/baytransit-widgets`, branch `main`, root directory `/server` |
| Region | `us-west2`, 1 replica |
| Hostnames | `baytransit.up.railway.app` **and `transitapi.transbay.dev`** (port 8080) |
| Builder | Railpack |

Two things in there matter more than they look.

**You already own `transitapi.transbay.dev` and it already points at this service.** That is
the whole domain problem solved in advance — the cutover becomes "move a domain between two
services", which Railway does in the dashboard with no DNS change and no propagation wait.

**The service builds from `/server` in the widgets repo, which no longer exists locally.** I
deleted it and committed that deletion, but **I did not push it**. Nothing is broken right
now. The moment that commit reaches `main`, this service's next build fails — it keeps
serving the last successful deployment, but a restart, a redeploy or a Railway-side migration
would leave the app with no backend. So: push it last.

## The recommended path

**Add a second service to the existing project, sharing the existing Redis.**

Not a new project. Sharing the Redis is the point, and it is what makes the overlap safe:

- The poller elects a leader through a Redis lease. Two services on one Redis means
  **exactly one of them polls**, so the 511 budget cannot be double-spent during cutover.
  Get this wrong — two Redis instances — and you are at 960 requests/hour against a 600/hour
  budget, and the symptom is 503s for everybody.
- Both services serve departures out of the same snapshot keys, and the new code's
  departures output is byte-identical to the old. So while both are up, they answer
  identically no matter which one wrote the snapshot.
- If anything is wrong, delete the new service. The old one retakes the lease within one
  cycle and you are exactly back where you started.

The new code writes additional keys (`obs:*`, `prof:*`, `pred:*`, `live:block:*`) that the
old code has never heard of, so there is nothing to collide.

---

## Step 1 — Push the repository

```bash
cd ~/Documents/GitHub/transitapi
git remote -v                      # should be Transbay/transitapi
git push -u origin main
```

Six commits, ending at "Learn which stops hold instead of trusting the timetable".

**Do not push `baytransit-widgets` yet.** That is step 8.

## Step 2 — Add the Postgres plugin

In the **BayTransit Widgets** project → **+ New** → **Database** → **PostgreSQL**.

It sets `DATABASE_URL` on services that reference it. Without it the service still boots and
serves every endpoint — it just learns nothing — so if you want to see the migration land
before paying for a database, skip this and come back.

## Step 3 — Create the API service

**+ New** → **GitHub Repo** → `Transbay/transitapi`.

| Setting | Value |
|---|---|
| Root Directory | **leave empty** — the code is at the repo root now, not under `/server` |
| Branch | `main` |
| Start Command | **`npm start`** — set it explicitly, see below |
| Health Check Path | `/health` |
| Builder | leave the default |

> **There is no `railway.json` any more, on purpose.** It used to carry
> `startCommand: npm start`, `healthcheckPath: /health` and a restart policy — every one of
> which is right for the API service and wrong for the cron service that now builds from the
> same repository. One file cannot describe two services with opposite needs, and the failure
> is silent in the worst direction: the cron job inherits `npm start`, boots a second API
> server, never builds a schedule, and never exits.
>
> So service-specific settings live on the service. Set the start command explicitly on both.

### Variables

Copy these across from `baytransit-widgets` — same values:

```
FIVEELEVEN_API_KEYS          all ten, comma-separated
FIVEELEVEN_HOURLY_LIMIT
APPLE_TEAM_ID
APP_BUNDLE_ID
JWT_SECRET                   must be identical, or every device re-attests
BART_API_KEY
BART_ENABLED
BART_ETD_INTERVAL_SECONDS
BART_SYNTHESIZE_VEHICLES
BART_OWN_TRIPUPDATES
POLL_MODE
POLL_INTERVAL_SECONDS
POLL_VEHICLES
ON_DEMAND_ENABLED
STATIC_REFRESH_HOURS
```

`JWT_SECRET` deserves the emphasis. Change it and every session token in the field becomes
invalid at once; each app re-attests, which works, but Apple only lets a device attest a
given key once and you would be forcing thousands of them through that path simultaneously.
Copy it exactly.

Reference the shared plugins rather than pasting values:

```
REDIS_URL       ${{Redis.REDIS_URL}}
DATABASE_URL    ${{Postgres.DATABASE_URL}}
```

New variables, none of them required:

```
POLLED_AGENCIES=*             publish every operator in the feed. Free -- both protobufs
                              already carry all of them. Your current service has the old
                              8-agency list; `*` is a superset and safe.
PROFILED_AGENCIES=SF,BA,CT,SM,GG
PREDICTION_MODE=shadow        compute and score corrections, never claim them
```

Do **not** set `PORT`. Railway injects it.

## Step 4 — Watch the first boot

```bash
curl -s https://<the new service's domain>/health | jq '{status, redis, profile: .profile | {warehouse, schedule, learner}}'
```

What you want to see:

| Field | Expected |
|---|---|
| `status` | `ok` |
| `redis` | `ok` |
| `profile.warehouse.connected` | `true` and `schemaVersion: 4` |
| `profile.warehouse.failures` | `0` |
| `profile.schedule.trips` | `0` for now — step 5 fixes that |

In the logs, `[warehouse] applied 001_schedule.sql` through `004_holds.sql` on the first
boot only.

### `leader: false` is expected, and it blocks learning

On a first deploy the old service already holds the poller lease, so the new one reports
`learner.leader: false` and sits idle. That is the shared-Redis safety mechanism doing its
job — exactly one service polls, so the 511 budget cannot be double-spent.

But it has a consequence worth being explicit about: **the observation pipeline only runs on
the lease holder.** While the old service is polling, the new one will never observe and
never learn, however long you leave it. `schedule.trips` and `learner.observations` stay at
zero and nothing is wrong.

So the handover is a deliberate step, and it comes *after* step 5:

1. Run the schedule build (step 5) so there is a schedule to measure against. This does not
   need the lease.
2. Set `POLL_ENABLED=false` on the **old** `baytransit-widgets` service.
3. Within about three cycles the new service takes the lease and starts polling and
   observing. The old service keeps answering `/v1/departures` from the same Redis — now
   written by the new code, whose departures output is byte-identical.

One variable, reversible in one variable. If anything looks wrong, set it back to `true` and
the old service retakes the lease on its next tick.

Doing it in the other order is harmless but pointless: the new service would start observing
with no schedule, `observeCycle` would bail immediately, and nothing would be collected.

## Step 5 — Create the schedule service

**+ New** → **GitHub Repo** → `Transbay/transitapi` again. Same repo, different service.

| Setting | Value |
|---|---|
| Start Command | **`npm run static`** — the single most important setting here |
| Cron Schedule | `20 10 * * *` (03:20 Pacific — after the service day has ended) |
| Health Check | **none.** It exits when finished |
| Restart Policy | **never** |
| Region | the same as Redis and Postgres. See below |

If the start command is left unset, Railpack falls back to the `start` script in
`package.json` and the cron job boots the API server instead: a second poller contending for
the lease, no schedule ever built, and a process that does not exit. Nothing errors.

It needs the **same variables**, including `APPLE_TEAM_ID`, `APP_BUNDLE_ID` and `JWT_SECRET`,
which it never uses — `config.ts` validates everything at import and refuses to boot on a
missing value. That is a property worth keeping; share the variables at the project level and
it costs nothing.

**Why a separate service.** Parsing 1.6 million stop times out of a 300 MB archive takes
about nine seconds and a few hundred megabytes of short-lived allocation. Inside the API
process that shows up as skipped poll cycles in the small hours, and it is a strange bug to
be handed six weeks later with nothing in the logs tying it to a nightly job that reported
success.

Run it manually once, now, then check:

```
[schedule] 46613 trips across SF, BA, CT, SM, GG
[schedule] version N: 46613 trips, 1619403 stop times, ~440 service days in ~7s
[static] done
```

`profile.schedule.trips` on the API service should reach ~10,000 within a few minutes — that
is today's and yesterday's active trips, not all 46,613.

## Step 6 — Confirm it is learning

Give it an hour, then:

```bash
curl -s https://<new domain>/health | jq '.profile.learner, .profile.observation.tracker.byTier, .profile.feed'
```

- `learner.ticks` climbing, `learner.observations` in the thousands per hour.
- `byTier` — the six counts are `[A1, A2, B, C, Cu, D]`. **This is the number that decides
  what the whole thing is worth.** Weight in the first two means vehicles are reporting
  themselves stopped and observations are direct. Weight only in C and Cu means every actual
  time is inferred from a prediction. `docs/03-observation.md` explains why that matters and
  what it disqualifies.
- `feed.<agency>.tierA` — the same question, stated per agency.
- `learner.streamDepth` should stay small. Climbing means the learner is falling behind and
  history is being dropped, which is the correct trade and still worth knowing.

Then leave it alone for three weeks. `/analysis/SF/14` will say "no profile yet" until
roughly then, and that is the honest answer rather than a fault.

## Step 7 — Move the domain

Only when steps 4–6 look right.

1. `baytransit-widgets` → Settings → Networking → remove `transitapi.transbay.dev`.
2. New service → Settings → Networking → add `transitapi.transbay.dev`, port 8080.

No DNS change; the CNAME already points into Railway.

Then generate a `*.up.railway.app` domain on the new service so it has a fallback of its own.

## Step 8 — Point the app, then retire the old service

The app does **not** currently use the custom domain. `ServerEnvironment.swift` compiles in:

```swift
public static let baseURL = URL(string: "https://baytransit.up.railway.app/v1/")!
```

That hostname belongs to the old service and dies with it. So:

1. Change that constant to `https://transitapi.transbay.dev/v1/` — keeping the `/v1/` and
   the trailing slash, both of which `appendingPathComponent` depends on.
2. Ship a build. Verify against the new host with `BAYTRANSIT_API_BASE_URL` in the scheme
   first, which works in debug builds only.
3. **Only once builds in the field are on the new host:** push the `baytransit-widgets`
   commit that deletes `server/`, then delete the `baytransit-widgets` Railway service.

Until every device that will ever update has updated, `baytransit.up.railway.app` has to keep
answering. That is the permanent cost of having compiled a Railway hostname into a shipped
binary, and it is exactly what the comment in `ServerEnvironment.swift` was warning about.

**If you would rather not wait:** keep the old service alive as a thin forwarder, or add
`baytransit.up.railway.app` as a domain on the new service — Railway will not let two
services share a hostname, so the old one has to give it up first, and it can only give it up
once it is no longer needed. Simplest is to leave the old service running until the update
tail is short enough not to care about.

---

## Cost

You are adding a Postgres instance and a second always-on service. On Hobby that is real but
modest; the numbers to size against:

| | |
|---|---|
| Postgres disk | provision 10 GB, expect 2–4 GB used at 90-day retention |
| API memory | 512 MB is comfortable — the profile is never held in memory |
| Redis | ~3× today's snapshot memory (24 operators instead of 8) plus ~50 MB of profile blobs |
| 511 requests | **unchanged.** The historical half costs one extra request a day |

If the disk is the concern, `PROFILE_RETENTION_DAYS=30` cuts the observation table by two
thirds and costs nothing except the ability to replay older history. The profiles themselves
are tiny and are kept regardless.

## Rolling back

| Situation | Action |
|---|---|
| New service misbehaving, domain not moved | Delete it. The old service retakes the lease within one cycle |
| Domain already moved | Move it back. Two dashboard clicks |
| Profile causing problems | `PROFILE_ENABLED=false`. Departures are unaffected either way |
| Postgres unhappy | Remove `DATABASE_URL`. The service boots and serves everything, and learns nothing |
| Want the old code back entirely | `baytransit-widgets` still has it until you push step 8 |

The last row is the reason step 8 is last.

## What I would not do

**Do not run two pollers on two separate Redis instances.** That is 960 requests/hour
against a 600/hour budget, and the failure mode is 503s for every user with a
`Retry-After` pointing at the top of the hour. The shared Redis is not a convenience, it is
the safety mechanism.

**Do not change `JWT_SECRET`.** See step 3.

**Do not set `POLL_MODE=siri` on the new service.** With `POLLED_AGENCIES=*` it costs one
request per agency per cycle — thousands per hour. The budget guard will refuse loudly, but
it is easier not to.
