# What moved, and what changed

## The move

`baytransit-widgets/server/**` became this repository's root. Railway's "Root Directory:
`server`" setting goes away with it.

Everything came across: `src/`, `certs/`, `package.json`, `package-lock.json`,
`tsconfig.json`, `.nvmrc`, `railway.json`, `.gitignore`, `.env.example`, `README.md`. The
package is renamed `transitapi` and `pg` is added.

**`.env` deliberately did not come across.** It holds ten live 511 keys and a JWT secret,
it is gitignored in the old repository, and it stays out of this one. Set the variables on
the Railway service.

The first commit here is that move with **no behavioural change at all**, so the delay-profile
work that follows reads as its own diff rather than being tangled with a relocation.

`baytransit-widgets` keeps the Xcode project, `guidelines.md`, `PRIVACY_POLICY.md`,
`SUPPORT.md` and `AppPreviews/`; its `server/` directory is deleted and its root
`.gitignore` loses the Node section. [`09-operations.md`](09-operations.md) has the ordering
for that deletion, which matters.

## What changed in the code that moved

Four things, all small, all justified independently of the new work.

### `loadTripTable()` is memoised

It did an `HGETALL` on a 94,000-field hash every fifteen seconds — several megabytes a cycle,
hundreds of kilobytes a second sustained — and rebuilt a large Map from bytes identical to
the ones already in memory, for a table that changes once a day. `loadBartGeometry()` next
to it had always been memoised on the feed version; these two simply never were.

Now both are. Same pattern, same version key.

### `readCSV` gained a positional variant

The existing reader builds a `Record<string, string>` per surviving row. That is exactly
right for `routes.txt` at a few thousand rows and exactly wrong for `stop_times.txt`:
filtered to five agencies it still yields around 2.4 million rows, and 2.4 million ten-key
objects is twenty to forty seconds of pure allocation and garbage collection.

`readCSVPositional` resolves the column indices once against the header and hands the caller
the raw cells. Same parsing, same prefilter, roughly a quarter of the time.

The shared core also now awaits a row callback **only when it returns something**, so a
caller writing in batches can apply back-pressure a few hundred times across those millions
of rows without adding millions of microtask hops.

### `POLLED_AGENCIES` defaults to `*`

Publish every operator the regional feed carries, and discover the list from the feed rather
than maintaining one. This costs no extra requests — both protobufs already contain all of
them — and means an operator joining 511 appears on its own while one leaving stops being
reported as permanently stale.

Two consequences, both handled:

- `snapshotStatus()` reports on the agencies we have actually written, from a Redis set,
  rather than on a configured list.
- **`POLL_MODE=siri` stops being a drop-in fallback.** It costs one request per agency per
  cycle, so at two dozen operators it needs thousands of requests an hour against a budget
  of six hundred. The budget guard now says so in its error message: the fallback is "poll a
  named subset", not "flip the switch".

### `groupTripUpdates` and `decodeVehiclePositions` accept a null filter

Meaning "every agency". One line each.

## What is new

Eighteen modules, three migrations, and this documentation. [`01-architecture.md`](01-architecture.md)
has the map. Nothing new is on the path of an existing response.

## The client contract

Frozen, and worth restating because the whole design turns on it.

The iOS app calls only `/v1/attest/challenge`, `/v1/attest/verify`, `/v1/operators`,
`/v1/lines`, `/v1/stops`, `/v1/patterns` and `/v1/departures`. It decodes strict RFC-3339
timestamps and derives "is this realtime" purely from whether a time arrives in `Expected*`
or `Aimed*`. `RegionalFeedContractTests.swift` and `SnapshotEnvelopeTests.swift` pin it with
payloads captured verbatim from this server.

**None of those responses changed.** Corrections live on `/v1/predictions`, a new endpoint,
and the analysis pages are new paths. A widget on a phone that has not been updated in six
months sees exactly what it saw before.

Three things the client does that constrain anything future:

- **One malformed timestamp fails an entire departures response.** The decoder runs its date
  strategy on any present key, so a single bad value drops the whole board to the cached
  batch, with no error anywhere.
- **`Expected*` versus `Aimed*` is the realtime flag.** Writing live times into `Aimed*`
  turns the app into a timetable silently — greyed out, no live indicator, and with the
  default setting most boards go empty.
- **`MonitoringRef` is not checked.** The client trusts the server to have filtered visits
  to the requested stop.

`ServerEnvironment.swift` compiles the host into the binary, with a `BAYTRANSIT_API_BASE_URL`
override in debug builds only. Its own comment already flags the `*.up.railway.app` hostname
as the thing that must be replaced with an owned domain before any App Store build — that
applies with more force now that the host is changing.

## What was considered and not done

**Per-agency static archives.** Five requests instead of one, smaller downloads, and a Muni
service change would stop invalidating BART's tables. But the regional archive's ids
(`SF:12345`) are the ones the regional realtime feed uses, and a per-agency archive publishes
them bare — matching a live trip to its schedule matters more than isolating the versions,
and keeping three versions live softens the changeover anyway.

**Generalising the geometry to all five agencies.** BART's shapes exist because BART
publishes no positions and its trains have to be placed on the track. The observation layer
turned out not to need geometry at all: sequence transitions and scheduled running times
carry it. Skipped, and noted in [`11-roadmap.md`](11-roadmap.md) as the prerequisite for a
geometric observation tier.

**Adding a trip reference to the departures snapshot.** Simpler than a parallel index, and it
would have changed the bytes of the one response that must not change.

**Subdirectories under `src/`.** The plan called for them at forty-odd modules. The existing
`src/` is flat with twenty-six, the names are unambiguous, and splitting would have meant
renaming half the originals for symmetry.
