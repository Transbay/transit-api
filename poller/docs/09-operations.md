# Operations

## Local

```bash
brew install node redis postgresql@16
redis-server --daemonize yes
brew services start postgresql@16
createdb transitapi

cd transitapi
npm install
curl -o certs/Apple_App_Attestation_Root_CA.pem \
  https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem

cp .env.example .env      # fill in the 511 keys, JWT_SECRET, DATABASE_URL
npm run build && npm start
```

Check it:

```bash
curl localhost:8080/health | jq .profile
curl -H "Authorization: Bearer $DEV_BYPASS_TOKEN" \
  "localhost:8080/v1/departures?agency=SF&stopcode=15419" -D- -o/dev/null
```

The Simulator cannot do App Attest at all, so set `DEV_BYPASS_TOKEN` to any string and send
it as the bearer token. It is a real hole; leave it unset in production.

### Tests

```bash
npm test                     # pure logic, no services needed
createdb transitapi_test
TEST_DATABASE_URL=postgres://localhost/transitapi_test \
TEST_REDIS_URL=redis://localhost:6379/9 npm test     # adds the end-to-end pass
```

The integration test flushes the Redis database it is pointed at. Point it at a spare one.

### Building a schedule locally

Costs one 511 request and a few hundred megabytes of transient memory:

```bash
npm run build && npm run static
```

## Railway

The API and the nightly schedule build are **two services on the same repo**, plus Redis and
Postgres.

### The API service

| | |
|---|---|
| Start | `npm start` |
| Health check | `/health` |
| Plugins | Redis (sets `REDIS_URL`), Postgres (sets `DATABASE_URL`) |
| Variables | `FIVEELEVEN_API_KEYS`, `APPLE_TEAM_ID`, `APP_BUNDLE_ID`, `JWT_SECRET` |

Do not set `PORT` — Railway injects it. Root Directory is the repo root; the old
`server` setting is gone.

### The schedule service

A cron service on the same repo, `npm run static`, once a day in the small hours.

**It is separate for a concrete reason.** Parsing 1.6 million stop times out of a 300 MB
archive takes nine seconds and peaks at a few hundred megabytes of short-lived allocation.
Inside the API process that shows up as skipped poll cycles at three in the morning — a
strange bug to be handed six weeks later, with nothing in the logs connecting it to a nightly
job that appeared to succeed.

It exits when finished, costs one 511 request, and leaves the previous schedule version live
if anything fails.

**It needs the same variables as the API**, including `APPLE_TEAM_ID`, `APP_BUNDLE_ID` and
`JWT_SECRET`, which it never uses. `config.ts` validates everything at import and refuses to
boot on a missing value — a deliberate property worth more than the small awkwardness of a
job carrying credentials it does not need. On Railway, share the variables at the project
level.

### Sizing

| | |
|---|---|
| API | 512 MB is comfortable. The schedule index is a few MB; the profile is not held in memory |
| Postgres | Provision 10 GB, expect 2–4 used at 90-day retention |
| Redis | Snapshots for ~24 operators plus ~50 MB of profile blobs |

## Cutover from `baytransit-widgets`

Order matters, and this is the one step that is awkward to undo.

1. **Deploy `transitapi` and verify it.** `/health` responds, a departures request returns
   the same body as the old server, per-agency stop counts look sane.
2. **Point an owned domain at it** — a `transbay.dev` subdomain, not `*.up.railway.app`.
   `ServerEnvironment.swift` compiles the host into the binary, and its own comment flags
   this as the thing that must not ship wrong: a Railway hostname in an App Store build is
   permanent for anyone who never updates.
3. **Ship a client build pointing at the new host,** or move the domain.
4. **Only then** push the commit that deletes `baytransit-widgets/server/`, and delete or
   stop the old Railway service.

Deleting the directory does not take production down — Railway keeps serving the last
successful deployment — but the *next* build of that service will fail, so a restart after
the delete would leave the app with no backend.

## Failure modes

The live path first, since that is the one people notice:

| Symptom | Cause | Response |
|---|---|---|
| Departures stale across every agency | Poller not leader, or 511 down | `/health` `poll.agencies[].ageSeconds`. Check the budget |
| Departures fine, names missing | Static tables empty | Force a static refresh |
| 503 with `Retry-After` | Budget exhausted | Check `budget`. Usually a misconfigured interval |
| BART positions gone | `bartShapes: 0` | Static refresh; BART geometry failed to load |

And the historical half, all of which fail **silently** — which is why the counters exist:

| Symptom | Cause | Response |
|---|---|---|
| `learner.streamDepth` climbing | Learner behind, or not leader | Check `learner.leader` and `lastTickMs`. Observations are being dropped |
| `warehouse.failures` rising | Postgres unhappy | History is being lost. Departures are unaffected |
| `rejected["no-schedule"]` dominant | Service change; the archive has not caught up | Run the schedule service manually. Three versions are kept, so this should be rare |
| `schedule.trips` zero | Schedule build never ran, or ran against an empty warehouse | Run `npm run static` |
| `hotProfile.routes` zero, `profileCells` large | Publishing failing | Check `learner.leader`; look for publish errors |
| `feed.<agency>.tierA` false | That agency stopped publishing `current_status` | Expected for BART. For others, its observations have silently dropped to the weakest tier |
| Coverage far from 0.8 | Variance inflation too small | Do not promote. See `07-evaluation.md` |

**The quiet one to watch for.** If the model is promoted and later regresses, the gate
reverts it automatically and `/health` says so — but nothing user-visible changes, because
`/v1/departures` never carried the correction. That is the design working. It also means
nobody will notice unless somebody is looking at the scores.

## Routine tasks

**Force a schedule rebuild** — run the cron service manually. One request, a couple of
minutes.

**Change retention** — `PROFILE_RETENTION_DAYS`. The next daily roll drops the partitions
that fall outside it. Dropping is instant; there is no vacuum storm.

**Turn the profile off entirely** — `PROFILE_ENABLED=false`, or remove `DATABASE_URL`. The
service boots, serves everything, learns nothing.

**Disable corrections for one agency** — the gate is stored in the database, so this does not
need a deploy.

**Reset a profile** — `DELETE FROM segment_profile WHERE agency = 'XX'` and let it relearn.
Three weeks. The observation history is untouched, so `backfill` could replay it.

## Environment

Everything not listed in the README's `.env.example`:

| Variable | Default | |
|---|---|---|
| `POLLED_AGENCIES` | `*` | `*` publishes every operator in the feed. A named list restricts it |
| `PROFILED_AGENCIES` | `SF,BA,CT,SM,GG` | Which operators get a history |
| `PROFILE_ENABLED` | `true` | Master switch for the historical half |
| `PROFILE_HALF_LIFE_DAYS` | `21` | How fast the profile forgets |
| `PROFILE_ICC` | `0.5` | Within-day correlation, for the design effect. Measure it |
| `PROFILE_HOLD_OFFSET` | `12` | Seconds past its published time a held vehicle leaves |
| `PROFILE_LEARN_INTERVAL` | `300` | Seconds between learner ticks |
| `PROFILE_RETENTION_DAYS` | `90` | Days of raw observations kept |
| `PROFILE_STREAM_MAXLEN` | `200000` | Observation stream cap |
| `PREDICTION_MODE` | `shadow` | `off` / `shadow` / `on` |
| `PREDICTION_MIN_SAMPLES` | `3` | Below this, a segment offers no correction |
| `DEPARTURES_CORRECTED` | `false` | Apply confident corrections to `/v1/departures` itself, same envelope. Needs `PREDICTION_MODE=on` |
| `DATABASE_URL` | — | Absent means no warehouse, which is supported |
| `DATABASE_POOL_SIZE` | `4` | |
| `DATABASE_MIGRATE` | `true` | Set false on a replica that must not race the leader |

## Security notes

The originals still hold — `/health` is public and exposes budget counts but never keys;
query strings are redacted from logs wholesale; assertions are not implemented, so a stolen
session token is usable until it expires.

Two additions:

- **`/analysis/*` and `/v1/profile/*` are open.** They serve aggregate statistics about
  public transit vehicles: no user data, no request data, nothing that is not already
  derivable from the public feed. If anything user-specific is ever added, they move behind
  auth.
- **`DATABASE_URL` is a credential** and belongs in Railway's variables, never in the repo.
  The same rule that keeps `.env` out of git.
