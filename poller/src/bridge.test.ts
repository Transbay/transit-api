import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * The bridge, against a real Redis.
 *
 * One claim matters more than the rest and this file exists mostly to hold it: **the
 * protobuf that comes out is the protobuf that went in, byte for byte**. The Go consumer
 * runs `proto.Unmarshal` on these bytes exactly as it used to run it on a 511 HTTP
 * response, so every field it derives downstream is unchanged by construction. If that
 * ever stops being true it will not surface as an error — it will surface as headways
 * quietly rendering slightly wrong buses — so it is asserted rather than assumed.
 *
 * Skipped unless Redis is configured, so `npm test` stays a pure-logic run:
 *
 *     TEST_REDIS_URL=redis://localhost:6379/9 npm test
 */

const REDIS = process.env.TEST_REDIS_URL

if (!REDIS) {
  test('bridge (skipped: set TEST_REDIS_URL)', { skip: true }, () => {})
} else {
  // Config reads the environment once at import, so this must land before anything else
  // in the service is loaded.
  process.env.REDIS_URL = REDIS
  process.env.FIVEELEVEN_API_KEYS ??= 'bridge-test'
  process.env.APPLE_TEAM_ID ??= 'TEST123456'
  process.env.APP_BUNDLE_ID ??= 'wato.BayTransit-Widgets'
  process.env.JWT_SECRET ??= 'bridge-test-secret'
  process.env.POLL_ENABLED = 'false'
  process.env.BRIDGE_ENABLED = 'true'
  process.env.BRIDGE_CORRECTIONS = 'true'
  process.env.BRIDGE_REGION = 'testregion'

  const { redis } = await import('./redis.js')
  const bridge = await import('./bridge.js')

  const VP = 'hw:vp:testregion'
  const TU = 'hw:tu:testregion'
  const CORR = 'hw:corr:testregion'

  const clean = async () => {
    await redis.del(VP, `${VP}:at`, TU, `${TU}:at`, CORR, `${CORR}:staging`, 'hw:bridge:v')
  }

  test('the feed republished is the feed received, byte for byte', async () => {
    await clean()

    // Bytes that would break anything doing a UTF-8 round trip: a lone 0xFF, an embedded
    // NUL, and a byte sequence that is not valid UTF-8. A real protobuf contains all
    // three kinds, which is exactly why the value has to be handled as binary.
    const vehicles = new Uint8Array([0x0a, 0x00, 0xff, 0xfe, 0x1f, 0x80, 0x7f, 0x00, 0xc3])
    const tripUpdates = new Uint8Array([0x12, 0xff, 0x00, 0x41, 0xed, 0xa0, 0x80])

    await bridge.publishFeeds(vehicles, tripUpdates, new Date('2026-09-09T18:22:04.000Z'))

    const gotVp = await redis.getBuffer(VP)
    const gotTu = await redis.getBuffer(TU)
    assert.deepEqual(new Uint8Array(gotVp!), vehicles, 'vehicle positions were altered in transit')
    assert.deepEqual(new Uint8Array(gotTu!), tripUpdates, 'trip updates were altered in transit')

    assert.equal(await redis.get(`${VP}:at`), '2026-09-09T18:22:04.000Z')
    assert.equal(await redis.get('hw:bridge:v'), '1')

    // The consumer treats an absent or expired feed as "fall back to 511", so a TTL that
    // silently failed to apply would leave it reading yesterday's buses forever.
    const ttl = await redis.ttl(VP)
    assert.ok(ttl > 0 && ttl <= 90, `expected a bounded TTL, got ${ttl}`)

    await clean()
  })

  test('one feed failing does not clear the other', async () => {
    await clean()
    const first = new Uint8Array([1, 2, 3])
    await bridge.publishFeeds(first, new Uint8Array([9]), new Date())

    // vehiclepositions rejected this cycle, tripupdates fine.
    await bridge.publishFeeds(null, new Uint8Array([8]), new Date())

    const stillThere = await redis.getBuffer(VP)
    assert.deepEqual(
      new Uint8Array(stillThere!),
      first,
      'a null feed overwrote the previous good one instead of leaving it',
    )
    await clean()
  })

  test('corrections below the confidence floor never reach the consumer', async () => {
    await clean()
    const written = await bridge.publishCorrections([
      { tripId: 'SF:1', stopId: '15419', correction: { p: 100, lo: 90, hi: 120, c: 'high', d: -30 } },
      { tripId: 'SF:2', stopId: '15419', correction: { p: 200, lo: 190, hi: 220, c: 'medium', d: -10 } },
      { tripId: 'SF:3', stopId: '15419', correction: { p: 300, lo: 290, hi: 320, c: 'low', d: -900 } },
      { tripId: 'SF:4', stopId: '15419', correction: { p: 400, lo: 390, hi: 420, c: 'none', d: 0 } },
    ])

    assert.equal(written, 2, 'the floor let through something it should have dropped')
    assert.equal(await redis.hlen(CORR), 2)

    // Unit-separated compound key, matching how gtfs.ts already packs these.
    const one = await redis.hget(CORR, 'SF:1\x1f15419')
    assert.deepEqual(JSON.parse(one!), { p: 100, lo: 90, hi: 120, c: 'high', d: -30 })
    assert.equal(await redis.hget(CORR, 'SF:3\x1f15419'), null, 'a low-confidence correction was published')

    await clean()
  })

  test('a cycle with nothing confident clears the previous cycle', async () => {
    await clean()
    await bridge.publishCorrections([
      { tripId: 'SF:1', stopId: '1', correction: { p: 1, lo: 0, hi: 2, c: 'high', d: -5 } },
    ])
    assert.equal(await redis.hlen(CORR), 1)

    // "Nothing was confident enough this cycle" is a real answer and has to replace the
    // last one. Leaving it would have the map showing a correction the model has since
    // stopped standing behind.
    const written = await bridge.publishCorrections([
      { tripId: 'SF:2', stopId: '2', correction: { p: 2, lo: 1, hi: 3, c: 'low', d: -900 } },
    ])
    assert.equal(written, 0)
    assert.equal(await redis.exists(CORR), 0, 'a stale correction set outlived its evidence')

    await clean()
  })

  test('status reports what a health check needs to alert on', async () => {
    await clean()
    await bridge.publishFeeds(new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6]), new Date())
    const s = bridge.bridgeStatus()
    assert.equal(s.enabled, true)
    assert.equal(s.region, 'testregion')
    assert.equal(s.vehicleBytes, 4)
    assert.equal(s.tripUpdateBytes, 2)
    assert.equal(s.failures, 0)

    bridge.reportBridgeFailure('publishFeeds', new Error('redis went away'))
    assert.equal(bridge.bridgeStatus().failures, 1)
    assert.match(bridge.bridgeStatus().lastError!, /redis went away/)

    await clean()
    await redis.quit()
  })
}
