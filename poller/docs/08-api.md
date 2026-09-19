# API

## Authentication

`/v1/*` data routes need `Authorization: Bearer <token>`, obtained by App Attest as
described in the README. `/health`, `/bart/*`, `/analysis/*` and `/v1/profile/*` are open:
they read only public transit data and have to work in a browser on a platform with no
token.

## The app's endpoints — unchanged

These five mirror the client's `TransitFeed` protocol one for one. Nothing in the
delay-profile work touches them.

| Method | Path | Query | Cache |
|---|---|---|---|
| `POST` | `/v1/attest/challenge` | — | — |
| `POST` | `/v1/attest/verify` | — | — |
| `GET` | `/v1/operators` | — | 7 days |
| `GET` | `/v1/lines` | `operator_id` | 24 h |
| `GET` | `/v1/stops` | `operator_id` | 24 h |
| `GET` | `/v1/patterns` | `operator_id`, `line_id` | 24 h |
| `GET` | `/v1/departures` | `agency`, `stopcode`, optional `corrected` | snapshot (~15 s) |
| `GET` | `/v1/vehicles` | `agency`, `line` | snapshot (~15 s) |

`/v1/departures` returns the SIRI `StopMonitoring` envelope. Headers:
`x-source: snapshot | live`, `x-snapshot-age`, `x-data-stale`, and `x-cache` on the
reference routes.

Three properties the client depends on, restated because breaking any of them is silent:

- **Every timestamp is strict RFC-3339 with a timezone.** One malformed timestamp fails the
  whole response — the decoder runs its date strategy on any present key — and the app falls
  back to its cached batch with no error anywhere.
- **Live times go in `Expected*`.** The client derives "is realtime" from that field's
  presence alone. Times in `Aimed*` render as scheduled, greyed out, and with the default
  setting the board goes empty.
- **Visits are already filtered to the requested stop.** The client does not check
  `MonitoringRef`.

### Learned times in `/v1/departures`

`corrected=1` applies proven corrections to this request; `corrected=0` never does. Without
the parameter the response follows `DEPARTURES_CORRECTED`, so builds that predate it are
unaffected. Proven means all three: what `/v1/predictions` would claim at the bridge's
confidence floor, with at least `PREDICTION_MIN_SAMPLES` behind it, and spot checks for that
agency and horizon showing our median miss beating the agency's over the last fortnight
(`ACCURACY_MIN_CHECKS`, see `accuracy.ts` and `/v1/profile/scores`). So nothing moves until
`PREDICTION_MODE=on` and the checks have accumulated.

Only the `Expected*` times move, by the same amount, preserving dwell. A moved visit carries
`MonitoredCall.Extensions`:

```json
{ "Adjusted": true, "AgencyExpectedDepartureTime": "2026-09-09T18:10:00Z" }
```

`x-corrected` reports how many visits moved.

## New: corrected predictions

### `GET /v1/predictions?agency=&stopcode=`

Requires a token. 404s for an agency that is not profiled, with the profiled list in the
body.

```json
{
  "agency": "SM",
  "stopCode": "473230",
  "generatedAt": "2026-09-04T15:40:12Z",
  "mode": "shadow",
  "cold": false,
  "predictions": [
    {
      "tripId": "SM:1049821",
      "lineRef": "172",
      "stopId": "473230",
      "raw": "2026-09-04T16:14:00Z",
      "predicted": "2026-09-04T15:57:12Z",
      "correctionSeconds": -1008,
      "p10": "2026-09-04T15:54:40Z",
      "p50": "2026-09-04T15:57:12Z",
      "p90": "2026-09-04T16:03:20Z",
      "confidence": "high",
      "basis": {
        "schedule": 1757001240,
        "profile": -998,
        "block": -55,
        "hold": 0,
        "agencyError": -12
      },
      "evidence": {
        "samples": 84,
        "level": "segment x daytype x 30min",
        "dayType": "Fri",
        "bucket": 16,
        "estimators": [
          { "name": "profile", "time": 1757000232, "weight": 0.712 },
          { "name": "agency",  "time": 1757001240, "weight": 0.288 }
        ],
        "clamps": ["tempered"],
        "disagreementSeconds": 1008
      }
    }
  ]
}
```

| Field | |
|---|---|
| `raw` | Exactly what the agency said. Always present |
| `predicted` | What we think. **Equal to `raw` whenever we decline to correct** |
| `p10` / `p50` / `p90` | The band, from the segment's histogram where one exists and a normal approximation otherwise |
| `confidence` | `none` / `low` / `medium` / `high`, or `shadow` when the mode says compute-but-do-not-claim |
| `basis` | The correction decomposed by source, in seconds. `schedule` is the epoch scheduled time |
| `evidence.samples` | **Effective** sample size at the weakest rung on the path, after the design effect |
| `evidence.level` | The finest ladder rung that spoke for itself |
| `evidence.estimators` | Each estimator's time and its share of the fusion |
| `evidence.clamps` | Which clamps fired. Frequent `capped` means the model is fighting the agency |
| `cold` | The agency has no profile yet. Every entry is the raw value |

`basis` and `evidence` are part of the contract, not debug output. A seventeen-minute
correction is only worth anything if you can see where it came from.

## New: the profile

Open, like `/health`.

### `GET /analysis/:agency/:route?direction=&daytype=`

An HTML heatmap: segments down the side, half hours across, coloured by seconds gained or
lost. Cells are desaturated by how little evidence is behind them; hover for the count.

Each segment is characterised:

| | |
|---|---|
| **scheduled slack** | Large negative mean, slope near zero. Padding in the timetable — it gives time back to every vehicle equally |
| **recovers delay** | Negative slope. Gives more back to a late vehicle than an early one |
| **loses time** | Positive mean |
| **runs to schedule** | Neither |
| **not enough data** | Under ten observations |

The first two are the distinction the page exists for. A map that cannot separate them
reports "delay is made up in the last three stops before the terminal", which is true of
every route in the world and useful for none of them.

### `GET /v1/profile/route?agency=&route=&direction=&daytype=`

The same numbers as JSON. `meanSeconds` alongside `meanRate` (the mean as a fraction of
scheduled running time), which is the comparable number between a nine-kilometre hop and a
two-hundred-metre one.

### `GET /v1/profile/scores`

The trailing fortnight of raw-versus-corrected scoring by agency and horizon, with
`improvementPercent` and `coverage`. See [`07-evaluation.md`](07-evaluation.md) for how to
read it.

## `GET /health`

Open. Existing sections (`poll`, `staticFeed`, `bart`, `budget`) are unchanged; a `profile`
section is added.

```json
{
  "profile": {
    "enabled": true,
    "agencies": ["SF", "BA", "CT", "SM", "GG"],
    "predictionMode": "shadow",
    "schedule": { "trips": 5842, "loadedFor": "2026-09-04", "ageSeconds": 4021, "failures": 0 },
    "learner": {
      "leader": true, "ticks": 288, "observations": 241033, "admitted": 228901,
      "rejected": { "no-schedule": 8122, "impossible-delta": 41 },
      "cellsWritten": 88213, "routesPublished": 1044,
      "streamDepth": 312, "lastTickMs": 890, "lastError": null
    },
    "warehouse": { "connected": true, "schemaVersion": 3, "scheduledTrips": 17526,
                   "observedDays": 12, "profileCells": 402118, "failures": 0 },
    "hotProfile": { "routes": 1044, "bytes": 51203841, "version": "1788..." },
    "observation": { "tracker": { "byTier": [...], "frozenAgencies": 0, ... } },
    "feed": { "SF": { "trips": 3011, "everStopped": 2874, "tierA": true }, "...": {} }
  }
}
```

**What to alert on**, since none of it is visible to a rider:

| Signal | Means |
|---|---|
| `learner.streamDepth` growing | The learner is falling behind; observations are about to be dropped |
| `warehouse.failures` rising | Postgres is unhappy. History is being lost, silently |
| `schedule.ageSeconds` past ~30 h | The nightly build has not run. Trips will stop matching |
| `observation.tracker.byTier` shifting toward the inferred tiers | An agency stopped publishing positions |
| `feed.<agency>.tierA` going false | Same, stated directly |
| `learner.rejected` climbing on `no-schedule` | A service change the archive has not caught up with |
| `hotProfile.routes` at zero with a populated warehouse | Publishing is failing; predictions are silently falling back to raw |

## Errors

| Code | When |
|---|---|
| 400 | A required query parameter is missing |
| 401 | No token, or an expired one. The client re-attests once |
| 404 | `/v1/vehicles` for an agency never indexed; `/v1/predictions` for an unprofiled agency |
| 502 | 511 unreachable or unparseable |
| 503 | Budget exhausted with no stale copy (`Retry-After` points at the top of the hour), or Redis unreachable |

The client treats 429 and 503 identically and reads only `Retry-After`.
