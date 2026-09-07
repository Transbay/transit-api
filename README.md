# BayTransit API

The server that stands between the iOS app and 511.org.

This file explains **why each part exists and what it talks to**. Read it top to
bottom once; after that, the section headings map one-to-one onto the files in `src/`.

---

## 1. Why there is a server at all

Before: every user pasted their own 511 API key into Settings. The key lived in the
device keychain and the app called `api.511.org` directly. That works, but it means
every new user has to go register for a developer key before the app does anything —
a wall most people will not climb.

After: we hold the keys. The user installs the app and it just works.

That trade has a catch, and the catch drives the entire design. 511 rate-limits
**per key, at 60 requests/hour**. When each user brought their own key, each user had
their own 60. Now everyone shares ours. We run **ten keys, so the ceiling is 600
requests/hour** — *for all users combined, forever*.

600/hour is still not much. A single widget refreshing every 30 seconds burns 120/hour
by itself.

**So this is not a proxy. It is a cache that happens to speak HTTP.** Everything
below is either "hold the keys safely" or "make 600 requests/hour serve everybody".

---

## 2. The parts, and how they connect

```
   iPhone app ─┐
               ├─► [ auth ] ─► [ routes ] ─► [ cache ] ─► [ keypool ] ─► [ upstream ] ─► 511.org
  Widget ext. ─┘       │                         │             │
                       │                         └── Redis ────┘
                   [ attest ]
```

A request flows left to right and **usually stops at `cache`**. That is the whole
trick: in steady state, most requests never reach `keypool`, so they cost nothing
against the 600/hour budget.

| File | Job | Talks to |
|---|---|---|
| `index.ts` | Boots Fastify, binds the port, shuts down cleanly | `routes` |
| `config.ts` | Reads every env var, exactly once, and fails loudly if one is missing | nothing |
| `routes.ts` | The endpoints; validates query params | `cache`, `auth`, `attest`, `snapshot` |
| `auth.ts` | Issues and checks session tokens | Redis |
| `attest.ts` | Proves a caller is a genuine build of *our* app | Apple's root cert |
| `cache.ts` | Read-through cache, request coalescing, stale fallback | Redis, `upstream` |
| `keypool.ts` | Picks which of the 10 keys spends the next request | Redis |
| `upstream.ts` | The one place that holds a 511 key and calls 511 | `keypool`, 511.org |
| `poller.ts` | Runs the sweep and the nightly archive refresh | `gtfs`, `gtfsrt`, `snapshot` |
| `gtfs.ts` | Nightly: turns the static GTFS archive into name tables | `names`, Redis |
| `gtfsrt.ts` | Decodes the regional protobuf and re-emits SIRI | `gtfs` |
| `names.ts` | Route badges and simplified destinations | nothing |
| `snapshot.ts` | Stores/reads the per-agency stop index and vehicles | Redis |
| `geo.ts` | Polyline maths and the geometry tables. Pure | nothing |
| `http.ts` | Keyless HTTP, and refuses to fetch 511 | nothing |
| `bart.ts` / `bartparse.ts` | BART's own APIs, and shaping their replies | `http` |
| `bartetd.ts` | Folds platform/cars/delay/"Leaving" into BART visits | `geo` |
| `bartposition.ts` | Places BART trains on the track. Pure | `geo` |
| `bartboard.ts` | The open `/bart/…` verification page | `snapshot`, `gtfs` |

---

## 3. The poller (`poller.ts`) — how this scales

511 publishes a **consolidated regional feed**: `agency=RG` returns *every*
real-time operator in the Bay Area in one request. That single fact is what the
architecture rests on.

So the server doesn't wait to be asked, and it doesn't ask per agency either. Every
15 seconds it makes two requests, splits the results by agency and stop code, and
keeps them in Redis. A client request for one stop is then an `HGET` — it never
reaches 511.

```
tripupdates?agency=RG        ~2,600 trips, ~62,000 stop times, 24 operators
vehiclepositions?agency=RG   ~1,400 live vehicles

2 requests / 15s = 480 requests/hour — at any number of users OR agencies
```

The cost depends on neither your userbase nor how many agencies you serve. Adding an
operator to `POLLED_AGENCIES` costs **zero** extra requests; it just stores more of a
response we already paid for.

**What this replaced.** The previous design swept SIRI `StopMonitoring` once per
agency — eight requests a cycle, which put a 60-second sweep at the edge of a ten-key
budget and made 15 seconds arithmetically impossible (1,920/hour, or 32 keys). Same
spend, four times fresher, three times the operators. `POLL_MODE=siri` restores the
old path if the regional feed ever breaks.

### Two clocks

GTFS-RT carries ids, not names: `trip_id`, `route_id`, `stop_id`, and an absolute
timestamp per stop. The rider-facing strings live in the *static* GTFS archive, which
changes a few times a year. So there are two loops:

| Loop | Every | Cost | Does |
|---|---|---|---|
| Realtime | 15s | 2 requests | Fetch, join against the name tables, store |
| Static | 24h | 1 request | Rebuild the name tables from the 60 MB archive |

`gtfs.ts` reads only `routes.txt`, `trips.txt` and `stops.txt` out of that archive —
285 MB of its 298 MB is `stop_times.txt` and `shapes.txt`, and we need neither,
because every stop time in the RT feed carries an absolute epoch (verified across the
whole feed; not one is delay-only). `yauzl` skips those entries rather than inflating
and discarding them.

> **511 quirk.** Their export endpoint appends its own HTML page after the zip bytes,
> so the archive fails EOCD validation in every strict reader. `trimTrailingBytes()`
> truncates at the offset the EOCD record declares. That trailing HTML embeds the API
> key in a form action — do not add debug output that dumps the tail of the file.

### Names (`names.ts`)

The old path showed whatever 511 sent: `JUDAH` for the N, `CALTRAIN/BALLPARK` as a
destination. GTFS is already better — `route_short_name` is `N` — but its headsigns
still carry operator bookkeeping no rider says out loud. So destinations are
simplified **once a night, when they're loaded**, not on the hot path:

```
Fruitvale BART            -> Fruitvale
Caltrain/Ballpark         -> Caltrain
Geary + 33rd Avenue       -> Geary & 33rd Ave
Fisherman`s Wharf         -> Fisherman's Wharf     (the feed uses a backtick)
San Francisco Int'l Airport -> SFO                 (an override, not a rule)
```

Two mechanisms in order: a small hand-written `OVERRIDES` table, then general rules.
When a rule gets a case wrong, **add an override** — reaching for a new rule to fix
one string is how you break nine others.

The one thing that is not cosmetic: `resolveRouteDestinations()` simplifies every
headsign on a route *together*, and reverts to the longer form if two of them would
collapse into the same label. Marin's 35 has two Northgate branches that differ only
by their `via`; shortening both to "Northgate" would leave a rider unable to tell
which bus was theirs. Correctness beats neatness, and that is the only place the
trade-off gets made.

### Why the wire format is still SIRI

`gtfsrt.ts` translates GTFS-RT back into the SIRI envelope the app already speaks.
That looks like extra work, and it is deliberate: `TransitKit` has Codable models for
SIRI, a decoder tuned to its date quirks, and a mapping into `Departure` that encodes
years of per-operator knowledge. Emitting the shape the client already reads means
**the entire iOS side of this migration is zero changes** — a build that has been on
someone's phone for six months keeps working the day this deploys.

`RegionalFeedContractTests.swift` pins that with payloads captured verbatim from this
server. If you change the SIRI output, re-capture them rather than editing them to
pass.

### The rest of the machinery

**Atomic swaps.** Each sweep writes to a staging key and `RENAME`s it into place, so
readers see the previous complete snapshot or the new one, never a half-written hash.
The swap also drops stops that vanished from the feed. The static tables use the same
discipline, so a nightly rebuild never exposes half a name table.

**One poller, not one per replica.** Railway can run more than one instance, and two
pollers would spend the budget twice for identical data. A short Redis lease, renewed
each cycle, elects a single leader; a replica that dies hands over within one cycle.

**No overlapping cycles.** A cycle that overruns its interval sets a flag that makes
the next tick skip, so a slow 511 degrades freshness instead of doubling the spend.

---

## 3a. BART — the operator with no positions

BART publishes **no vehicle positions anywhere.** Not in 511's regional feed (1,442
vehicles across 24 operators, zero BART), and not in its own GTFS-RT, which 404s on every
vehicle-position URL. So BART's trains are not fetched, they are **inferred**.

For each BART trip we know when it reaches each upcoming stop, and where those stops sit
along the track (`shapes.txt`, loaded nightly for BART only). That is enough to place it:

```
now within [arrival, departure]   -> stationary at that stop
now between two predicted stops   -> interpolate over the track between them
now before the first prediction   -> walk back from it toward the previous station
```

Three things that are easy to get wrong, and were all wrong once:

- **Dwell is given, not modelled.** Both feeds publish an arrival *and* a departure for
  every BART stop, median 18 s apart. Interpolating across `arrival → arrival` slides a
  train out of a station it is still sitting in — ~170 m on a two-minute segment.
- **The feed lists only *upcoming* stops,** so a moving train is almost always *before*
  its first prediction — 47 of 58 at a typical moment. Placing it at that stop parks the
  whole fleet in stations.
- **Speed comes from the length of the segment the train is on,** never from a
  neighbouring one. A train leaving West Oakland is crossing a 9.4 km tube; the next
  segment it runs is a 570 m downtown hop at half the speed. Using the latter put a train
  7 km into the Bay.

`shape_dist_traveled` in this feed is **not metres** — about 3.05 m per unit — so
distances are remeasured from the coordinates. Self-consistent units still place a train
correctly, which is why this hid; they do not give a correct speed, and 20 mph for BART
reads as perfectly plausible.

Every synthesized record carries `source: 'synthesized'` and a `confidence`. A map must
draw low-confidence trains differently: an inferred dot gliding past a platform while the
real train sits late is a confident lie, and riders calibrate on the first one that burns
them.

**Checking it.** `/bart/:station` is open, needs no token, counts down by the second, and
prints each train's position, speed and confidence beside the board — so the estimate can
be falsified from a platform rather than admired from a desk. `/health` carries the
canaries (`implausibleSpeed`, `implausibleOffset`), both impossible if the arithmetic is
right.

The ETD blend costs nothing against the 511 budget and adds the four things 511 lacks:
platform, car count, delay, and the authoritative `Leaving` flag — which also clamps that
departure to `now`, so builds already on people's phones show "Now" without a client
change.

---

## 4. The cache (`cache.ts`) — for everything the poller doesn't cover

Three behaviours, each solving a distinct problem.

**Read-through.** On a hit, return immediately. On a miss, fetch, store, return.
Departures are cached for 25 seconds; reference data (`operators`, `lines`, `stops`,
`patterns`) for a day or more, because it changes on the order of months.

The win: ten people watching Powell St within the same 25 seconds cost **one**
upstream request between them. Popular stops get close to free, and popular stops are
most of the traffic.

**Coalescing.** Here is the subtle one. iOS wakes many widget timelines at the same
moment. They all miss the same expired cache key within the same few milliseconds,
and — without protection — they all fetch. You would see a healthy-looking overall
hit rate while the popular stops, the exact ones the cache exists for, quietly paid
full price.

So an in-flight fetch is recorded in a `Map`, and concurrent callers for the same key
`await` the same promise. Verified: 10 simultaneous cold requests → 1 upstream call.

**Stale-on-failure.** Every value is written twice — once with the real TTL, once
under a `:stale` suffix with 20× the TTL. If 511 is down or the budget is spent, we
serve the stale copy and set `x-data-stale: true`.

This is a product decision, not a technical one: a departures widget showing
90-second-old times is still useful; one showing an error is not.

---

## 5. The key pool (`keypool.ts`)

Three keys, 60/hour each. Naively using key #1 until it 429s would give us 60/hour
with extra steps, so each request goes to the **least-used key with headroom**.

Counts live in Redis, not in memory, for two reasons:

1. They must survive a deploy. 511 does not reset its tally because we restarted.
2. They must be shared. If Railway ever runs two instances, two in-memory counters
   would each believe they had the full 600 and together spend 1,200.

The count is incremented **before** the request goes out and never rolled back —
mirroring what the client used to do before the server took the budget over, and for the
same reason: 511
counts a request the moment it arrives, so a timeout or a 429 has still spent one.

When all three are exhausted, `/v1/*` returns **503 with a `Retry-After`** pointing at
the top of the hour — but only if there was no stale copy to serve, because the cache
gets first refusal.

---

## 6. Authentication (`attest.ts` + `auth.ts`)

Without auth, our endpoints spend *our* budget on behalf of anyone who finds the URL.

**App Attest** is Apple's answer: the Secure Enclave generates a key, and Apple
issues a certificate chain attesting that the key belongs to a genuine, unmodified
build of a specific app on real Apple hardware. It says nothing about *who the user
is* — which suits an app with no accounts.

`verifyAttestation` checks five things, in order, and each one is load-bearing:

1. **Chain of trust** — leaf ← Apple intermediate ← Apple root. Everything else is
   meaningless without it.
2. **Freshness** — the attestation answers a nonce *we* issued and stored. Without
   this, one captured attestation could be replayed forever.
3. **Key binding** — the claimed key ID is the SHA-256 of the certificate's actual
   public key.
4. **App identity** — `rpIdHash` equals SHA-256 of `TEAMID.bundle.id`. Step 1 proves
   "some attested app"; *this* step proves it is ours. Skipping it would let any
   App Attest-enabled app on the store spend our budget.
5. **Environment** — production attestations only, unless `ALLOW_DEV_ATTESTATION`.

Attestation happens **once**. Apple only lets an app attest a given key once, and the
check is expensive, so we exchange a successful attestation for a **30-day JWT**. The
app stores it in the shared keychain group; the widget extension — which has a tiny
execution budget and cannot run an attestation flow — only ever reads it.

---

## 7. Endpoints

All `/v1/*` data routes need `Authorization: Bearer <token>` and mirror the five methods
of the client's `TransitFeed` protocol one-for-one
(`TransitKit/Sources/TransitKit/Server/TransitFeed.swift`). Swapping this server for a
different API means writing one new `TransitFeed` conformer on the client; nothing above
that protocol changes.

| Method | Path | Cache TTL |
|---|---|---|
| `POST` | `/v1/attest/challenge` | — |
| `POST` | `/v1/attest/verify` | — |
| `GET` | `/v1/operators` | 7 days |
| `GET` | `/v1/lines?operator_id=` | 24 h |
| `GET` | `/v1/stops?operator_id=` | 24 h |
| `GET` | `/v1/patterns?operator_id=&line_id=` | 24 h |
| `GET` | `/v1/departures?agency=&stopcode=` | snapshot (~15 s) |
| `GET` | `/v1/vehicles?agency=&line=` | snapshot (~15 s) |
| `GET` | `/bart/:station` (also `/:line/:station`, `/:line/:direction/:station`) | — (open) |
| `GET` | `/health` | — (open, for Railway) |

`/v1/departures` returns the **SIRI envelope**, built by `gtfsrt.ts` from the regional
feed. It is no longer a 511 passthrough, but it is byte-compatible with what the
client's SIRI decoder has always read — see section 3.

`/v1/vehicles` is the one endpoint that is *not* SIRI-shaped. It is new, so there was
no existing client model to stay compatible with, and it returns a flat list chosen
for the reader:

```json
{ "agency": "SF", "ageSeconds": 7, "vehicles": [
  { "id": "2084", "lineRef": "N", "lineName": "N", "destination": "Caltrain",
    "directionRef": "OB", "lat": 37.78410, "lon": -122.40784, "bearing": 315,
    "speed": 0, "nextStopId": "15419", "nextStop": "Metro Powell Station",
    "occupancy": "many seats", "at": "2026-09-06T18:45:02Z" } ] }
```

`line` filters server-side — Muni alone reports ~420 vehicles and a map showing one
route should not ship the other 95% to the device.

Reference responses (`operators`, `lines`, `stops`, `patterns`) are still passed
through **unchanged** from 511 and still carry
`x-cache: fresh | hit | coalesced | stale`. Snapshot responses carry `x-source:
snapshot | live` and `x-snapshot-age` instead.

---

## 8. Running it locally

```bash
brew install node redis
redis-server --daemonize yes

cd server
npm install
curl -o certs/Apple_App_Attestation_Root_CA.pem \
  https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem

cp .env.example .env      # then fill in the three 511 keys and a JWT_SECRET
npm run build && npm start
```

The Simulator cannot do App Attest at all, so set `DEV_BYPASS_TOKEN` to any string
and send it as the bearer token. It is a real hole — leave it unset in production.

Check it works:

```bash
curl localhost:8080/health
curl -H "Authorization: Bearer $DEV_BYPASS_TOKEN" \
  "localhost:8080/v1/departures?agency=SF&stopcode=15419" -D- -o/dev/null
```

---

## 9. Deploying to Railway

1. **New Project → Deploy from GitHub repo**, pointed at this repo.
2. **Settings → Root Directory: `server`** — otherwise Railway sees the Xcode project
   and has no idea what to build.
3. **Add the Redis plugin.** It sets `REDIS_URL` automatically.
4. **Variables:** `FIVEELEVEN_API_KEYS` (all ten, comma-separated), `APPLE_TEAM_ID`,
   `APP_BUNDLE_ID`, `JWT_SECRET` (`openssl rand -base64 48`). Do *not* set `PORT` —
   Railway injects it.
5. **Settings → Networking → Generate Domain**, then verify `/health` responds.
6. **Add a custom domain you own** before shipping any build to TestFlight.

That last point is the one that bites hardest. A `*.up.railway.app` hostname compiled
into an App Store binary is permanent — you cannot change it for users who never
update. Own the domain, point it here, and you can move providers later without
stranding anyone.

Cost: the Hobby plan at $5/month covers this workload comfortably.

---

## 10. Things to watch

- **`/health` is public.** It exposes budget counts, never the keys. If you add
  anything sensitive to it, put it behind auth.
- **Fixed-window rate counting** can allow a 2× burst across an hour boundary. Harmless
  while the cache keeps us far from the ceiling; if you ever approach it, switch to a
  sliding window rather than raising the limit.
- **Assertions are not implemented.** App Attest also supports signing each individual
  request. We attest once and use a JWT instead, which is a deliberate simplification —
  a stolen token is usable until it expires. Worth revisiting if abuse ever appears.
- **Query strings are redacted from logs** wholesale. Ours carry nothing secret, but
  this is the one process that handles 511 keys, and a logged key is a leaked key.
- **The static tables are the quiet failure.** If the nightly refresh fails, the live
  feed keeps working while every departure loses its name — the app shows times with
  raw ids as labels rather than erroring. `/health` reports `staticFeed.version` and
  `staticFeed.trips` for exactly this reason; alert on the version going stale, not
  just on the process being up.
- **A service change desynchronises the two feeds.** 511 publishes a new schedule
  hours before the archive we mirror catches up, so trips appear in the RT feed that
  the static tables have never seen. Those still get published — a time with a thin
  label beats no bus — and the poller warns when more than half the trips are
  unmatched. That warning means "force a static refresh", not "something is broken".
- **`POLL_MODE=siri` is the escape hatch,** not an equal option: one request per
  agency per cycle, no vehicle positions, and 511's raw headsigns instead of the
  simplified ones. Raise `POLL_INTERVAL_SECONDS` to 60 if you switch to it.
