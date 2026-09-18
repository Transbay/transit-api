# transit-api — what's left

Handoff notes. The bridge between the poller and the headways API is built, tested and
committed; what remains is deployment plus porting the three non-511 regions across.

**Repo:** `~/Documents/GitHub/transit-api` — `Transbay/transit-api`, 9 commits on `main`,
**not pushed yet**.

---

## Where things stand

One repo, two services, one Redis.

```
                    511 regional feed (2 req / 15s)
                              │
                  ┌───────────▼───────────┐
                  │  poller/   (Node)     │  polls, learns, predicts
                  └──┬─────────────────┬──┘
          Postgres   │                 │   Redis
     profiles,       │      ┌──────────▼─────────────┐
     schedule,       │      │ hw:vp:<region>   feeds │
     prediction_     │      │ hw:tu:<region>         │
     error           │      │ hw:corr:<region> fixes │
                     │      │ hw:bridge:v      version│
                     │      └──────────┬─────────────┘
                  ┌──▼─────────────────▼──┐
                  │ headways-server (Go)  │  GraphQL /api, repo root
                  └───────────┬───────────┘
                              │
                  headways frontend  (DO NOT TOUCH — see below)
```

Done:

- Node service merged in under `poller/` with its full history (`git subtree`). No Go file
  moved, so `git pull upstream main` from `rkvmar/headways-server` still merges cleanly.
- Poller republishes the 511 protobuf **unmodified**; Go reads Redis instead of polling 511.
- Corrected departure times feed `trip.delay`, so the map's timeliness colouring improves
  with zero frontend changes.
- Prediction-drift model (`poller/src/drift.ts`) learning for **all ~24 agencies**.
- Archive downloaded once a day total instead of 25 times.
- `BRIDGE.md` in the repo root is the deployment runbook. Read it before step 1.

---

## 1. Deploy and cut over  ← start here

Full detail in `BRIDGE.md`. Every step is one env var and a restart, and rollback is
setting it back.

- [ ] Add the Go service to the **same Railway project** as the poller. It must share that
      Redis instance — see the budget gotcha below.
- [ ] Give it `REDIS_URL`, `MONGODB_URI`, `SOUND_TRANSIT_API_KEY`, and a **volume mounted
      at `data/`**. Leave `BRIDGE_ENABLED` unset: it polls 511 exactly as it does today, so
      this step changes nothing observable. Confirm the map works.
- [ ] `BRIDGE_ENABLED=true` on the **poller**. Nothing reads it yet. Check `/health`:
      `bridge.vehicleBytes` non-zero, `bridge.failures` 0.
- [ ] **Run the parity diff** (`BRIDGE.md` step 3): same GraphQL response with the bridge
      on vs off, `fetchedAt` and `delay` masked. Must be empty. A difference means the
      bridge is reshaping bytes it promised not to — stop and find out why.
- [ ] `BRIDGE_ENABLED=true` on the **Go service**.
- [ ] Repoint `headwaysapi.rkmr.dev` DNS. Keep the old host answering until TTL expires.
- [ ] Later, once stable for a few days: `GTFS_ARCHIVE_URL`, then `BRIDGE_CORRECTIONS=true`,
      then fold `LOCATIONS_API_KEY` / `TRIP_UPDATES_API_KEY` / `API_KEY` into
      `FIVEELEVEN_API_KEYS` (10 keys → 13, 600 → 780 req/hour).

---

## 2. Port SacRT, Elk Grove and Seattle onto the bridge

These three still poll their own upstreams from inside the Go server. They are **not** in
511's regional feed, so the poller cannot serve them until it fetches them itself. All are
public and keyless (Seattle needs an OBA key), so this costs nothing against the 511 budget.

The real prize is not tidiness — it is that moving them into the poller brings them into
the learner, so Sacramento and Elk Grove start getting drift corrections too.

The bridge was built region-generic for exactly this: `hw:vp:<region>` already takes
`sacrt`, `elk`, `seattle`.

**Poller side** — add each as an extra poll target writing its own region keys. Reuse
`publishFeeds()` in `poller/src/bridge.ts`; it takes the region from config today, so it
needs a region argument rather than a new function.

| Region | Vehicles | Trips |
|---|---|---|
| `sacrt` | `https://bustime.sacrt.com/gtfsrt/vehicles` | `.../gtfsrt/trips` |
| `elk` | `https://bustime.sacrt.com/EG_gtfsrt/vehicles` | `.../EG_gtfsrt/trips` |
| `seattle` | OneBusAway JSON, not protobuf — see below |

**Go side** — much easier than the 511 swap was. Both `sacrt.go:463` and `elk.go:463` go
through a single `fetchBody(url)`, so one bridge-aware wrapper covers both:

```go
// Mirror fetchFeedBytes in main.go: try the bridge, fall back to the direct URL,
// and keep the direct fetch throttled (claimDirectFetch) so a bridge outage cannot
// hammer the upstream at the new tick rate.
func fetchRegionBody(region, kind, url string) ([]byte, error)
```

- [ ] SacRT (protobuf, same shape as 511 — do this one first, it's the template)
- [ ] Elk Grove (identical to SacRT)
- [ ] Seattle — **different**: OneBusAway serves JSON, not GTFS-RT protobuf. The
      byte-identity contract does not apply, so either give it its own key shape and version
      it separately, or convert to protobuf in the poller. Do not quietly reuse `hw:vp`,
      which is documented as raw 511 protobuf.
- [ ] Once a region is on the bridge, add it to the drift model — it needs no schedule, so
      it is close to free.

Also worth knowing: SacRT/Elk/Seattle only download their **static** GTFS at process start,
with no periodic refresh (unlike the Bay Area's daily). A service change means a restart.
`elk.go:9` has a note from the original author about folding these three into one shared
Region type; that refactor is still a good idea and would make this port much smaller.

---

## 3. Widen the segment profiles

Drift already covers every agency. The heavier **segment** profile (running time between
stops — the travel-time estimates) is still just `SF,BA,CT,SM,GG`.

- [ ] Widen `PROFILED_AGENCIES` in stages, largest operators first (AC Transit, then VTA).
- [ ] After **each** stage, check `/health` → `hotProfile.bytes` against the Redis plan's
      memory limit before continuing.

The binding constraint is **Redis, not Postgres**: hot profile blobs are ~51 MB at five
agencies and carry no TTL by design, so all 24 is roughly 250 MB. Postgres is comfortable
(~1.5 M cells). If Redis becomes the limit, publish blobs only for routes actually queried
and let the long tail read from Postgres.

Each stage needs ~3 weeks of observation before it means anything. "No change" during that
window is correct behaviour, not a failure.

---

## 4. Validate the drift model (after ~1 week of data)

```sql
-- The claim under test: does BART really slip ~20s on approach?
SELECT agency, horizon, round(mean::numeric,1) AS drift_s, round(n::numeric) AS n
FROM prediction_error
WHERE source = 'drift' AND agency = 'BA' AND horizon < 3
ORDER BY horizon;

-- Confirm it is genuinely all-agency and not silently filtered to the profiled five.
SELECT count(DISTINCT agency) FROM prediction_error WHERE source = 'drift';  -- want ~24
```

- [ ] Confirm ~24 distinct agencies. This is the easiest thing to get silently wrong, since
      every *other* learning path in the codebase filters to `PROFILED_AGENCIES`.
- [ ] Once the observed path exists, compare `source='drift'` against `source='observed'`
      for the five agencies that have both. They should agree. **If they diverge, drift is
      the one to distrust** — it grades a producer against its own last word, which measures
      convergence, not correctness.
- [ ] BART ETD: deliberately not built. The general drift model may already capture the
      quantisation. Check the query above before adding anything BART-specific.

---

## Gotchas — please read

**Do not touch `~/Documents/GitHub/headways`.** The frontend stays as it is. The whole
migration was designed so that repo needs zero changes — that is why the DNS gets repointed
instead of the env var. One trap if you ever do change the API hostname:
`+page.svelte:671` sniffs the API URL for the string `socal` to choose logo paths.

**`hw:vp` and `hw:tu` are the 511 protobuf, byte for byte.** The Go server runs
`proto.Unmarshal` on them exactly as it ran it on the HTTP response, so everything
downstream is correct by construction. If you need to reshape them, that is a **new key and
a `bridge.version` bump**, never an edit — a consumer cannot detect the change, and the
failure mode is plausible, wrong buses rather than an error. Both ends assert this
(`poller/src/bridge.test.ts`, `bridge_test.go`) on bytes that break a UTF-8 round trip.

**Do not remove the direct-fetch throttle** (`claimDirectFetch` in `main.go`). The Go server
ticks every 5 seconds because a Redis read is free, but 511 is rate limited *per key per
hour*. Without the one-minute floor on the fallback path, a bridge outage fires 720
requests/hour against a 60/hour key, exhausts it in minutes, and takes the poller's shared
budget down with it.

**One Redis, shared.** Both services run the same `poller:leader` lease, so only one process
can poll whatever its keys are. Two *separate* Redis instances means two pollers and double
the spend against one budget.

**Leave `BRIDGE_FALLBACK=true` for at least a week.** It is the only thing between a Redis
outage and an empty map, on a server that never needed Redis before.

**`prediction_error` has a `source` column** (migration 005). `drift` and `observed` are
different measurements and must never share a cell — averaging them gives a number that is
neither, with no symptom.

**BART reaches the map through `hw:vpx`, not `hw:vp`.** Its trains are synthesised, so
they ride a separate feed the Go server appends after decoding 511's bytes (see
`BRIDGE.md`). Styling (colour, name, logo) lives in the `Transbay/headways` fork.

**Don't reformat.** Prettier is not configured and the existing sources don't satisfy it;
`gofmt` likewise leaves several pre-existing files unformatted. Running either produces a
huge diff against the original author's style.

**Tests skip without `data/`.** `go test ./...` is green in a fresh checkout because the
GTFS-dependent tests skip with a message. Run the server once to populate `data/` and they
assert for real.

---

## Commands

```bash
# Node
cd poller && npm install && npm test        # 191 pass, 2 skipped
npm run typecheck

# with the Redis-backed tests
TEST_REDIS_URL=redis://localhost:6379/9 npm test

# Go (from repo root)
go build ./... && go vet ./... && go test ./...
TEST_REDIS_URL=redis://localhost:6379/9 go test ./...

# run locally
cd poller && npm start          # poller, :8080
go run .                        # headways API, :8081
```

`poller/.env` is gitignored and holds the 511 key pool — copy it by hand, git will not
bring it across.
