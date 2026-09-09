import test from 'node:test'
import assert from 'node:assert/strict'
import type { TripSchedule } from './schedule.js'
import type { Deviation } from './deviation.js'

/**
 * The whole pipeline, against a real Redis and a real Postgres.
 *
 * Everything else in this repo is a unit test of a pure function, which is where the
 * interesting reasoning lives — but "the pure parts are correct" and "the service learns
 * something" are different claims, and only this file makes the second one. It runs a
 * synthetic route through the actual observation, event-log, learner and prediction path
 * and checks that a segment which reliably runs early ends up predicted early.
 *
 * Skipped unless both are configured, so `npm test` stays a pure-logic run:
 *
 *     createdb transitapi_test
 *     TEST_DATABASE_URL=postgres://localhost/transitapi_test \
 *     TEST_REDIS_URL=redis://localhost:6379/9 npm test
 */

const DB = process.env.TEST_DATABASE_URL
const REDIS = process.env.TEST_REDIS_URL

if (!DB || !REDIS) {
  test('integration (skipped: set TEST_DATABASE_URL and TEST_REDIS_URL)', { skip: true }, () => {})
} else {
  // Config reads the environment exactly once at import, so these must be in place before
  // anything else in the service is loaded.
  process.env.DATABASE_URL = DB
  process.env.REDIS_URL = REDIS
  process.env.FIVEELEVEN_API_KEYS ??= 'integration-test'
  process.env.APPLE_TEAM_ID ??= 'TEST123456'
  process.env.APP_BUNDLE_ID ??= 'wato.BayTransit-Widgets'
  process.env.JWT_SECRET ??= 'integration-test-secret'
  process.env.PROFILED_AGENCIES ??= 'SF'
  process.env.POLL_ENABLED = 'false'

  const { redis } = await import('./redis.js')
  const warehouse = await import('./warehouse.js')
  const eventlog = await import('./eventlog.js')
  const store = await import('./profilestore.js')
  const learner = await import('./learner.js')
  const { epochSecondsFor, localDate, dayTypeOf, bucketOf } = await import('./servicedate.js')
  const { Tier } = await import('./observe.js')
  const { segmentKey } = await import('./schedule.js')
  const { estimate, fromPacked, noEstimate, Level } = await import('./profile.js')
  const { propagate } = await import('./predict.js')

  const DATE = localDate(Date.now())
  const DAY = dayTypeOf(DATE)
  const AGENCY = 'SF'
  const ROUTE = 'SF:TEST'

  /** A six-stop route with three-minute hops, all at 08:00. */
  function trip(id: string): TripSchedule {
    const stops = []
    for (let i = 0; i < 6; i++) {
      const t = 8 * 3600 + i * 180
      stops.push({ stopId: `SF:S${i}`, seq: i + 1, arrival: t, departure: t, timepoint: false })
    }
    return {
      agency: AGENCY,
      tripId: id,
      routeId: ROUTE,
      directionId: 0,
      patternId: 'ptest',
      serviceId: 'svc-test',
      blockId: 'blk-test',
      shortName: '',
      stops,
    }
  }

  /** One observed stop, running `earlyBy` seconds ahead of schedule. */
  function deviation(t: TripSchedule, i: number, earlyBy: number, priorEarly: number) {
    const stop = t.stops[i]
    const prev = t.stops[i - 1]
    const scheduledDeparture = epochSecondsFor(DATE, stop.departure)
    return {
      agency: AGENCY,
      tripId: t.tripId,
      routeId: ROUTE,
      directionId: 0,
      patternId: 'ptest',
      blockId: 'blk-test',
      vehicleId: `veh-${t.tripId}`,
      serviceDate: DATE,
      stopId: stop.stopId,
      seq: stop.seq,
      scheduledArrival: epochSecondsFor(DATE, stop.arrival),
      scheduledDeparture,
      actualArrival: undefined,
      actualDeparture: scheduledDeparture - earlyBy,
      devArrival: undefined,
      devDeparture: -earlyBy,
      priorDev: -priorEarly,
      delta: -(earlyBy - priorEarly),
      dwell: undefined,
      segmentKey: segmentKey({
        agency: AGENCY,
        routeId: ROUTE,
        directionId: 0,
        fromStopId: prev.stopId,
        toStopId: stop.stopId,
        occurrence: 0,
      }),
      corridorKey: `${prev.stopId}>${stop.stopId}`,
      tripStart: false,
      scheduledRun: 180,
      bucket: bucketOf(stop.departure),
      dayType: DAY,
      timepoint: false,
      held: false,
      tier: Tier.A1,
      sigma: 12,
      composite: false,
      predictions: [],
    } satisfies Deviation
  }

  test('the warehouse migrates from nothing', async () => {
    await warehouse.connect()
    assert.equal(warehouse.available(), true, 'expected a usable warehouse')

    // Start from a clean slate so repeated runs mean something.
    await redis.flushdb()
    store.clearCache()

    // Learning and publishing are gated on holding the poller's lease, so the test has to
    // hold it. That gate is the thing that stops two replicas double-counting every cell,
    // and it would be the wrong thing to loosen for a test's convenience.
    learner.bindLease('integration-test')
    // With a TTL, and released again at the end. A lease set without one squats the key
    // forever: point this test at a Redis that a real poller also uses and that poller
    // stops polling permanently, silently, because the lock is doing exactly its job.
    await redis.set('poller:leader', 'integration-test', 'EX', 300)

    const status = await warehouse.status()
    assert.equal(status.connected, true)
    assert.ok(status.schemaVersion >= 3 || status.profileCells >= 0)
  })

  test('a schedule round-trips through Postgres', async () => {
    const version = await warehouse.beginFeedVersion([AGENCY])
    assert.ok(version, 'expected a feed version')

    const trips = [trip('SF:T1'), trip('SF:T2'), trip('SF:T3')]
    assert.equal(await warehouse.saveTrips(version!, trips), 3)
    assert.equal(
      await warehouse.saveServiceDays(
        version!,
        [{ agency: AGENCY, serviceId: 'svc-test', day: DATE }],
      ),
      1,
    )
    await warehouse.activateFeedVersion(version!)

    const back = await warehouse.loadTripsFor([AGENCY], [DATE])
    const one = back.find((t) => t.tripId === 'SF:T1')
    assert.ok(one, 'expected the trip back')
    assert.equal(one.stops.length, 6)
    assert.equal(one.stops[2].departure, 8 * 3600 + 2 * 180, 'times survive as service-day seconds')
    assert.equal(one.blockId, 'blk-test')
  })

  test('observations reach the learner through the event log', async () => {
    const t = trip('SF:T1')
    // Thirty trips, each gaining 40 seconds on every segment: a route that reliably runs
    // early, which is exactly the case this whole system exists to notice.
    const batch = []
    for (let n = 0; n < 30; n++) {
      const run = trip(`SF:T${n}`)
      for (let i = 1; i < run.stops.length; i++) {
        batch.push(deviation(run, i, i * 40, (i - 1) * 40))
      }
    }
    // Through the event log, deliberately -- `learnFrom(batch)` would hand the learner the
    // same in-memory objects the poller built, and that is precisely the shortcut that hid
    // a showstopper: `Deviation.segment` was never serialised, so in production every real
    // observation arrived at the learner with no segment and was rejected as having no
    // schedule. The pipeline has to be tested across the boundary it actually crosses.
    await eventlog.append(batch)
    assert.ok((await eventlog.depth()) >= batch.length)

    await learner.learnerTick()

    const cells = await warehouse.routeProfile(AGENCY, ROUTE, 0, DAY)
    assert.ok(cells.length > 0, 'expected the learner to have written cells')

    const pooled = cells.filter((c) => c.bucket === -1)
    assert.ok(pooled.length >= 5, `expected a cell per segment, got ${pooled.length}`)
    for (const c of pooled) {
      assert.ok(c.mean < -25, `expected each segment to have learned it runs early: ${c.mean}`)
      assert.ok(c.n > 10, `expected real evidence: ${c.n}`)
    }
  })

  test('the hot profile is published and read back', async () => {
    await learner.learnerPublish()
    store.clearCache()

    const segments = await store.load(AGENCY, ROUTE, 0, DAY)
    assert.ok(segments.size >= 5, `expected a published blob, got ${segments.size} segments`)

    const first = [...segments.values()][0]
    assert.ok(first.meanAll < -25, `blob carries the learned mean: ${first.meanAll}`)
    assert.ok(first.nAll > 10)
    assert.equal(first.scheduledRun, 180)
  })

  test('a route that runs early is predicted early, end to end', async () => {
    const segments = await store.load(AGENCY, ROUTE, 0, DAY)
    const t = trip('SF:T1')
    const now = Math.floor(Date.now() / 1000)

    const result = propagate(
      t,
      DATE,
      0,
      5,
      0,
      (i) => {
        const from = t.stops[i - 1]
        const to = t.stops[i]
        const packed = segments.get(`${from.stopId}>${to.stopId}`)
        return packed
          ? estimate(fromPacked(packed, bucketOf(from.departure), now))
          : (noEstimate())
      },
      null,
    )

    // Five segments each reliably gaining about forty seconds.
    assert.ok(result.deviation < -120, `expected minutes early, got ${result.deviation}s`)
    assert.equal(result.steps, 5)
  })

  test('trip observations are written and partitioned', async () => {
    await warehouse.rollPartitions(DATE)
    const written = await warehouse.writeTripObservations([
      {
        serviceDate: DATE,
        agency: AGENCY,
        tripId: 'SF:T1',
        routeId: ROUTE,
        directionId: 0,
        patternId: 'ptest',
        blockId: 'blk-test',
        vehicleId: 'veh-1',
        seqs: [1, 2, 3],
        stopIds: ['SF:S0', 'SF:S1', 'SF:S2'],
        schedDep: [1, 2, 3],
        actDep: [1, 2, 3],
        actArr: [0, 0, 0],
        devDep: [0, -40, -80],
        delta: [warehouse.ABSENT, -40, -40],
        tiers: [0, 0, 0],
        held: [false, false, false],
        predErr: [60, -12],
        anomalous: false,
      },
    ])
    assert.equal(written, 1)

    const status = await warehouse.status()
    assert.ok(status.observedDays >= 1)
  })

  test('everything shuts down cleanly', async () => {
    // Hand the lease back explicitly rather than waiting out its TTL.
    if ((await redis.get('poller:leader')) === 'integration-test') {
      await redis.del('poller:leader')
    }
    await warehouse.close()
    await redis.quit()
  })
}
