import type { FastifyInstance } from 'fastify'
import { config } from './config.js'
import { cached } from './cache.js'
import { fetchUpstream, UpstreamError } from './upstream.js'
import { NoKeyAvailableError, BudgetUnavailableError, budgetSnapshot } from './keypool.js'
import { verifyAttestation, AttestationError } from './attest.js'
import { readSnapshot, snapshotStatus, readVehicles } from './snapshot.js'
import { staticStatus } from './gtfs.js'
import { bartSynthesisStatus, observationStats, feedSurvey } from './poller.js'
import { bartBreakerStatus } from './bart.js'
import { registerBartBoard } from './bartboard.js'
import { registerAnalysis } from './analysis.js'
import { registerDash } from './dash.js'
import { registerBoard } from './board.js'
import { registerMapkit, mapkitStatus } from './mapkit.js'
import { predictionsFor, indexStatus } from './predictions.js'
import { learnerStatus } from './learner.js'
import * as warehouse from './warehouse.js'
import * as profilestore from './profilestore.js'
import * as scheduleIndex from './scheduleindex.js'
import {
  issueChallenge,
  consumeChallenge,
  issueSessionToken,
  requireSession,
} from './auth.js'

/** The HTTP surface, mirroring FiveElevenClient's five methods one for one. */

/** Cache keys must encode every input that changes the answer, or users see each other's stops. */
const cacheKeys = {
  operators: () => '511:operators',
  lines: (operatorId: string) => `511:lines:${operatorId}`,
  stops: (operatorId: string) => `511:stops:${operatorId}`,
  patterns: (operatorId: string, lineId: string) => `511:patterns:${operatorId}:${lineId}`,
  departures: (agency: string, stopCode: string) => `511:departures:${agency}:${stopCode}`,
}

export async function registerRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // Attestation. Open by necessity — this is how a device earns its token.
  // ---------------------------------------------------------------------------

  app.post('/v1/attest/challenge', async () => {
    return { challenge: await issueChallenge() }
  })

  app.post<{ Body: { keyId?: string; attestation?: string; challenge?: string } }>(
    '/v1/attest/verify',
    async (request, reply) => {
      const { keyId, attestation, challenge } = request.body ?? {}
      if (!keyId || !attestation || !challenge) {
        return reply.code(400).send({ error: 'keyId, attestation and challenge are required' })
      }

      // Redeemed before verification, and redeemable only once. Verifying first would
      // let an attacker grind attempts against a single live challenge.
      if (!(await consumeChallenge(challenge))) {
        return reply.code(401).send({ error: 'Unknown or already-used challenge' })
      }

      try {
        const { keyId: verifiedKeyId } = await verifyAttestation(attestation, keyId, challenge)
        const { token, expiresIn } = issueSessionToken(verifiedKeyId)
        return { token, expiresIn }
      } catch (err) {
        if (err instanceof AttestationError) {
          request.log.warn({ reason: err.message }, 'attestation rejected')
          return reply.code(401).send({ error: 'Attestation failed' })
        }
        throw err
      }
    },
  )

  // ---------------------------------------------------------------------------
  // Data. Everything below requires a session token.
  // ---------------------------------------------------------------------------

  app.register(async (secured) => {
    secured.addHook('preHandler', requireSession)

    secured.get('/v1/operators', async (_request, reply) => {
      const result = await cached(cacheKeys.operators(), config.ttl.operators, () =>
        fetchUpstream('operators', {}),
      )
      reply.header('x-cache', result.outcome)
      return result.value
    })

    secured.get<{ Querystring: { operator_id?: string } }>(
      '/v1/lines',
      async (request, reply) => {
        const operatorId = request.query.operator_id
        if (!operatorId) return reply.code(400).send({ error: 'operator_id is required' })

        const result = await cached(cacheKeys.lines(operatorId), config.ttl.lines, () =>
          fetchUpstream('lines', { operator_id: operatorId }),
        )
        reply.header('x-cache', result.outcome)
        return result.value
      },
    )

    secured.get<{ Querystring: { operator_id?: string } }>(
      '/v1/stops',
      async (request, reply) => {
        const operatorId = request.query.operator_id
        if (!operatorId) return reply.code(400).send({ error: 'operator_id is required' })

        const result = await cached(cacheKeys.stops(operatorId), config.ttl.stops, () =>
          fetchUpstream('stops', { operator_id: operatorId }),
        )
        reply.header('x-cache', result.outcome)
        return result.value
      },
    )

    secured.get<{ Querystring: { operator_id?: string; line_id?: string } }>(
      '/v1/patterns',
      async (request, reply) => {
        const { operator_id: operatorId, line_id: lineId } = request.query
        if (!operatorId || !lineId) {
          return reply.code(400).send({ error: 'operator_id and line_id are required' })
        }

        const result = await cached(
          cacheKeys.patterns(operatorId, lineId),
          config.ttl.patterns,
          () => fetchUpstream('patterns', { operator_id: operatorId, line_id: lineId }),
        )
        reply.header('x-cache', result.outcome)
        return result.value
      },
    )

    /** The only endpoint under real load. */
    secured.get<{ Querystring: { agency?: string; stopcode?: string } }>(
      '/v1/departures',
      async (request, reply) => {
        const { agency, stopcode: stopCode } = request.query
        if (!agency || !stopCode) {
          return reply.code(400).send({ error: 'agency and stopcode are required' })
        }

        let snapshot = null
        try {
          snapshot = await readSnapshot(agency, stopCode)
        } catch (err) {
          // A snapshot read failure is not fatal — fall through to the live path.
          request.log.warn({ err, agency, stopCode }, 'snapshot read failed')
        }

        const fresh = snapshot !== null && snapshot.ageSeconds <= config.poll.onDemandAfterSeconds

        if (fresh) {
          reply.header('x-source', 'snapshot')
          reply.header('x-snapshot-age', String(snapshot!.ageSeconds))
          return snapshot!.response
        }

        // The snapshot is stale, or we have none. Spend a request only if allowed to.
        const mayFetchLive = config.poll.hybrid || snapshot === null
        if (mayFetchLive) {
          try {
            const result = await cached(
              cacheKeys.departures(agency, stopCode),
              config.ttl.departures,
              () => fetchUpstream('StopMonitoring', { agency, stopcode: stopCode }),
            )
            reply.header('x-source', 'live')
            reply.header('x-cache', result.outcome)
            if (result.outcome === 'stale') reply.header('x-data-stale', 'true')
            return result.value
          } catch (err) {
            // Budget exhausted or 511 unreachable. An aged snapshot beats an error:
            // times a couple of minutes old are still useful, a spinner is not.
            if (snapshot === null) throw err
            request.log.warn({ err, agency }, 'live fetch failed, serving aged snapshot')
          }
        }

        reply.header('x-source', 'snapshot')
        reply.header('x-snapshot-age', String(snapshot!.ageSeconds))
        reply.header('x-data-stale', 'true')
        return snapshot!.response
      },
    )

    /**
     * Corrected predictions for one stop.
     *
     * A new endpoint rather than a change to `/v1/departures`, deliberately. That response
     * is byte-compatible with app builds that have been on people's phones for months and
     * nothing here may move it; a reader who wants a correction asks for one, and every
     * entry carries what the agency said alongside what we think and how much evidence
     * stands behind the difference.
     */
    secured.get<{ Querystring: { agency?: string; stopcode?: string } }>(
      '/v1/predictions',
      async (request, reply) => {
        const { agency, stopcode: stopCode } = request.query
        if (!agency || !stopCode) {
          return reply.code(400).send({ error: 'agency and stopcode are required' })
        }
        if (!config.profile.agencies.includes(agency)) {
          return reply.code(404).send({
            error: `No profile for agency ${agency}`,
            profiled: config.profile.agencies,
          })
        }
        return predictionsFor(agency, stopCode)
      },
    )

    /** Live vehicle positions for one agency. */
    secured.get<{ Querystring: { agency?: string; line?: string } }>(
      '/v1/vehicles',
      async (request, reply) => {
        const { agency, line } = request.query
        if (!agency) return reply.code(400).send({ error: 'agency is required' })

        const stored = await readVehicles(agency)
        if (stored === null) {
          // Distinguishable from "no vehicles running": the agency has never been
          // indexed, which usually means it isn't in POLLED_AGENCIES.
          return reply.code(404).send({ error: `No vehicle data for agency ${agency}` })
        }

        const vehicles = line
          ? stored.vehicles.filter(
              (v) => (v as { lineRef?: string }).lineRef === line,
            )
          : stored.vehicles

        reply.header('x-source', 'snapshot')
        reply.header('x-snapshot-age', String(stored.ageSeconds))
        return { agency, ageSeconds: stored.ageSeconds, vehicles }
      },
    )
  })

  // ---------------------------------------------------------------------------
  // Operations.
  // ---------------------------------------------------------------------------

  /**
   * Unauthenticated on purpose: Railway's health checks cannot attest, and this reveals
   * nothing but aggregate counts.
   */
  // Open, like /health: it must work in a browser on a platform, with no token. Reads
  // only Redis, serves only public transit data.
  await registerBartBoard(app)

  // Same reasoning as the BART board: a delay profile is an inference, and the only honest
  // way to ship an inference is to make it easy to catch being wrong. Reads only public
  // transit data.
  await registerAnalysis(app)

  // The dashboard over the same data, which exists because /analysis/:agency/:route only
  // answers if you already know the route AND the day type -- and the day type is a trap,
  // since owl service files under the previous day. This one offers what exists.
  await registerDash(app)

  // Mints the short-lived, origin-restricted token MapKit JS needs. Optional: with no key
  // configured it reports 503 and the pages fall back to their tables.
  await registerMapkit(app)

  // A board for every operator, not just BART. Registered LAST on purpose: it owns the
  // two- and three-segment catch-alls (`/sf/15419`, `/sf/14/15419`), and while Fastify
  // prefers static segments regardless of order, registering it after everything else
  // means the precedence is obvious to a reader rather than a property they must know.
  await registerBoard(app)

  app.get('/health', async () => {
    try {
      const [budget, snapshots, staticFeed, learner, wh, hot, predIndex] = await Promise.all([
        budgetSnapshot(),
        snapshotStatus(),
        staticStatus(),
        learnerStatus(),
        warehouse.status(),
        profilestore.status(),
        indexStatus(),
      ])
      return {
        status: 'ok',
        redis: 'ok',
        poll: {
          enabled: config.poll.enabled,
          mode: config.poll.mode,
          intervalSeconds: config.poll.intervalSeconds,
          vehicles: config.poll.vehicles,
          hybrid: config.poll.hybrid,
          agencies: snapshots,
        },
        // The static tables are the most common thing to be silently wrong: the live
        // feed keeps working while every departure loses its name, so surface their
        // age where a health check can see it.
        staticFeed,
        bart: {
          enabled: config.bart.enabled,
          breaker: bartBreakerStatus(),
          synthesis: bartSynthesisStatus(),
        },
        // Whether the maps will draw, and why not if they will not. The key id is
        // truncated: it is not a secret, but a health endpoint is not the place to
        // publish credentials-adjacent identifiers in full.
        maps: mapkitStatus(),
        /**
         * The historical half.
         *
         * Every counter here is something that can go wrong quietly. `tierMix` says what
         * the observations are actually made of -- an agency whose observations are all
         * inferred cannot train a prediction-error model without measuring its own
         * predictions against themselves. `rejected` says what is being refused and why.
         * `streamDepth` growing means the learner is falling behind and history is about to
         * be dropped, which is the correct trade and still worth knowing about.
         */
        profile: {
          enabled: config.profile.enabled,
          agencies: config.profile.agencies,
          predictionMode: config.predictions.mode,
          schedule: scheduleIndex.status(),
          learner,
          warehouse: wh,
          hotProfile: hot,
          predictionIndex: predIndex,
          observation: observationStats(),
          feed: feedSurvey(),
        },
        budget,
      }
    } catch (err) {
      return { status: 'ok', redis: 'unavailable', error: (err as Error).message }
    }
  })

  // ---------------------------------------------------------------------------
  // One place where upstream problems become HTTP responses, so no route has to
  // remember to translate them.
  // ---------------------------------------------------------------------------

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof NoKeyAvailableError) {
      // Every key is spent and we had no stale copy to fall back on. Retry-After
      // points at the top of the hour, when the budget windows roll over.
      reply.header('retry-after', String(error.retryAfterSeconds))
      return reply.code(503).send({
        error: 'Upstream budget exhausted, try again shortly',
        retryAfter: error.retryAfterSeconds,
      })
    }

    if (error instanceof BudgetUnavailableError) {
      // Redis is unreachable, so we can't know what we've already spent. Refusing is
      // the safe answer; the cache layer has already tried its stale copy by now.
      request.log.error({ err: error }, 'budget counter unreachable')
      reply.header('retry-after', '30')
      return reply.code(503).send({ error: 'Temporarily unavailable, try again shortly' })
    }

    if (error instanceof UpstreamError) {
      return reply.code(error.status).send({ error: error.message })
    }

    request.log.error(error)
    return reply.code(500).send({ error: 'Internal server error' })
  })
}
