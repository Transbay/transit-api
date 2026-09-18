# The bridge, and how to cut over to it

This repo holds two services that share one Redis.

| | |
|---|---|
| **`headways-server`** (Go, repo root) | GraphQL `/api` for the headways map. Enrichment, static GTFS, the SacRT / Elk Grove / Seattle regions |
| **`poller`** (Node, `poller/`) | Polls 511, serves `/v1/*`, learns delay profiles and prediction drift |

Before this, both polled 511 independently — two pollers, one shared per-key rate limit,
and the map running on the worse and staler of the two answers. Now the poller is the only
thing that talks to 511 and republishes what it fetched.

```
                        511 regional feed
                     (2 requests / 15s, all operators)
                                │
                    ┌───────────▼────────────┐
                    │  poller   (Node)       │
                    └──┬──────────────────┬──┘
             Postgres  │                  │  Redis
        profiles,      │        ┌─────────▼──────────────┐
        schedule,      │        │ hw:vp:<region>   feeds │
        prediction_    │        │ hw:tu:<region>         │
        error          │        │ hw:corr:<region> fixes │
                       │        │ hw:bridge:v      version│
                       │        └─────────┬──────────────┘
                       │                  │ read-only
                    ┌──▼──────────────────▼──┐
                    │ headways-server  (Go)  │
                    └───────────┬────────────┘
                                │
                    headways frontend (untouched)
```

## The one rule

**`hw:vp` and `hw:tu` are the 511 protobuf, byte for byte.**

The Go server runs `proto.Unmarshal` on those bytes exactly as it used to run it on the
HTTP response, so every field derived downstream — headsigns, block ids, the vehicle roster
join — is unchanged by construction rather than by care. Reshaping them is a new key and a
`bridge.version` bump, never an edit: a consumer has no way to notice the difference, and
the failure mode is plausible, wrong buses rather than an error.

Both ends assert this, on bytes that a UTF-8 round trip destroys — `poller/src/bridge.test.ts`
and `bridge_test.go`.

## Vehicles 511 does not carry

BART publishes no positions, so the poller places its trains from trip updates and track
geometry (`poller/src/bartposition.ts`) and publishes them as a GTFS-RT feed of its own on
`hw:vpx:<region>`. The Go server appends those entities to the 511 feed *after*
unmarshalling it, so the one rule above still holds. The key is additive: the contract
version does not move, and a missing or stale `hw:vpx` means no BART, never an error.
Trip ids are the archive's own (`BA:<trip>`), so the existing static join supplies route,
shape and headsign. `BRIDGE_SYNTH_VEHICLES=false` on the poller takes BART off the map.

## Environment

### poller (Node)

Everything in `poller/.env.example`, plus:

| Variable | Default | |
|---|---|---|
| `BRIDGE_ENABLED` | `false` | Publish the feeds at all |
| `BRIDGE_REGION` | `sfbay` | Which region these feeds represent |
| `BRIDGE_CORRECTIONS` | `false` | Also publish corrected departure times |
| `BRIDGE_TTL_SECONDS` | `90` | How long a published feed stays readable |
| `BRIDGE_MIN_CONFIDENCE` | `medium` | Floor a correction must clear to be published |
| `BRIDGE_SYNTH_VEHICLES` | `true` | Publish BART's synthesised trains on `hw:vpx` |

### headways-server (Go)

| Variable | Default | |
|---|---|---|
| `PORT` | `8081` | Railway injects this; do not set it by hand |
| `REDIS_URL` | — | The **same** Redis the poller uses. Required for the bridge |
| `BRIDGE_ENABLED` | `false` | Read the feeds from Redis instead of 511 |
| `BRIDGE_REGION` | `sfbay` | Must match the poller |
| `BRIDGE_CORRECTIONS` | `false` | Apply corrected times to `trip.delay` |
| `BRIDGE_FALLBACK` | `true` | Fall back to 511 when the bridge is not serving |
| `BRIDGE_MAX_AGE_SECONDS` | `90` | Refuse a feed older than this |
| `GTFS_ARCHIVE_URL` | — | e.g. `http://poller.railway.internal:8080/internal/gtfs.zip` |
| `MONGODB_URI` | — | Vehicle photos only. Unrelated to any of the above |
| `SOUND_TRANSIT_API_KEY` | — | Seattle region; that region is disabled without it |
| `LOCATIONS_API_KEY`, `TRIP_UPDATES_API_KEY` | — | Only used when falling back to 511 |
| `API_KEY` | — | Only used when `GTFS_ARCHIVE_URL` is unset or failing |

The Go server needs a writable `data/` for the extracted archive, shapes and precomputed
trip details. On Railway that means a volume, or accepting a re-download and re-parse on
every restart.

## Cutting over

Reversible at every step, and each step is one variable and a restart.

1. **Deploy the Go service** into the same Railway project as the poller, so it can reach
   the private network and the same Redis. Leave `BRIDGE_ENABLED=false`. It polls 511
   exactly as it always has. Confirm `/health` returns `status: ok` and the map works.

2. **Turn the bridge on at the poller.** `BRIDGE_ENABLED=true`. Nothing consumes it yet.
   Confirm on the poller's `/health`:

   ```
   bridge.lastPublishAt   moving
   bridge.vehicleBytes    non-zero
   bridge.failures        0
   ```

3. **Prove parity before switching the reader.** Run the Go server twice against the same
   instant, once each way, and diff the enriched output:

   ```bash
   Q='{"query":"query{vehicleFeed{data{entity{id vehicle{trip{tripId routeId shapeId}
      position{latitude longitude} stopId currentStopSequence vehicleMake}}}}}"}'
   curl -s -XPOST localhost:8081/api -d "$Q" -H 'content-type: application/json' \
     | jq -S '.data.vehicleFeed.data.entity|sort_by(.id)' > /tmp/a.json
   # flip BRIDGE_ENABLED on the Go service, restart, repeat into /tmp/b.json
   diff /tmp/a.json /tmp/b.json    # must be empty
   ```

   A difference means the bridge is reshaping bytes it promised not to. Stop and find out
   why; do not proceed.

4. **Repoint DNS.** `headwaysapi.rkmr.dev` at the new service. The headways repo is not
   touched — no `.env` edit, no rebuild, no iOS resubmit. Keep the old host answering until
   the TTL expires.

5. **Point the archive at the poller.** Set `GTFS_ARCHIVE_URL`. Confirm the next refresh
   logs `datafeeds: fetched the poller's retained archive`.

6. **Turn corrections on**, once the feeds have been stable for a few days.
   `BRIDGE_CORRECTIONS=true` on both. Only corrections at `medium` confidence or better
   move a displayed time, so this cannot make the number worse than the agency's own.

7. **Merge the freed keys.** The Go server no longer calls 511 at all, so
   `LOCATIONS_API_KEY`, `TRIP_UPDATES_API_KEY` and `API_KEY` can join
   `FIVEELEVEN_API_KEYS`. Ten keys become thirteen: 600 → 780 requests/hour.

## What to watch

None of this is visible to someone looking at the map, which keeps rendering happily on
whatever it fetched last. A dead bridge looks exactly like working software until the buses
stop moving.

| Signal | Means |
|---|---|
| `bridge.failures` rising (poller `/health`) | Publishing is failing; the map is going stale |
| `vehiclePositions.ageSeconds` climbing (Go `/health`) | The Go server is not reading anything current |
| `bridge: falling back to 511` in the Go log | The bridge is not serving. A steady trickle is a broken bridge wearing working software's face |
| Budget above ~480/hour after step 4 | The Go server has not actually stopped calling 511 |
| `profile.drift.abandoned` climbing against `emitted` | A producer is dropping stops before they arrive, starving the drift model of converged answers |

The fallback throttle is worth knowing about: the Go server ticks every five seconds
because a bridge read is free, but a direct 511 fetch is floored at one a minute. Without
that, a bridge outage would fire 720 requests an hour against a sixty-an-hour key and take
the poller's budget down with it.

## Rolling back

`BRIDGE_ENABLED=false` on the Go service and restart. It polls 511 as before. Nothing else
has to change, and `BRIDGE_FALLBACK=true` means it will already have been doing exactly
that while the bridge was down.

Do not turn off `BRIDGE_FALLBACK` until the bridge has run clean for a week — it is the
only thing standing between a Redis outage and an empty map, on a server that never needed
Redis before.
