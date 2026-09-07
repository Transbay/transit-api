import { randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { config } from './config.js'
import { redis } from './redis.js'

/**
 * Turns "this device passed App Attest once" into "this device may call the API for the next
 * 30 days".
 */

interface SessionClaims {
  /** The attested App Attest key ID. Our only notion of "who" a caller is. */
  sub: string
}

/** Issues a challenge for the device to attest against. */
export async function issueChallenge(): Promise<string> {
  const challenge = randomBytes(32).toString('base64url')
  await redis.set(`attest:challenge:${challenge}`, '1', 'EX', 300)
  return challenge
}

/** Consumes a challenge, returning whether it was valid. */
export async function consumeChallenge(challenge: string): Promise<boolean> {
  const removed = await redis.del(`attest:challenge:${challenge}`)
  return removed === 1
}

export function issueSessionToken(keyId: string): { token: string; expiresIn: number } {
  const expiresIn = config.auth.sessionTtlDays * 24 * 60 * 60
  const token = jwt.sign({ sub: keyId } satisfies SessionClaims, config.auth.jwtSecret, {
    expiresIn,
    issuer: 'baytransit-api',
  })
  return { token, expiresIn }
}

/**
 * Fastify preHandler that rejects anything without a valid session token.
 *
 * Registered on the /v1 data routes only — the challenge and verify endpoints must
 * stay open, since they are how a device gets a token in the first place.
 */
export async function requireSession(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing bearer token' })
  }
  const token = header.slice('Bearer '.length)

  // The Simulator cannot do App Attest at all, so development needs a way in. This
  // is a real hole and is why config refuses to invent a default for it: if
  // DEV_BYPASS_TOKEN is unset, as it must be in production, this branch is dead code.
  if (config.auth.devBypassToken && token === config.auth.devBypassToken) {
    request.deviceId = 'dev-bypass'
    return
  }

  try {
    const claims = jwt.verify(token, config.auth.jwtSecret, {
      issuer: 'baytransit-api',
    }) as SessionClaims
    request.deviceId = claims.sub
  } catch {
    // Deliberately vague: expired and forged tokens get the same answer, so the
    // response cannot be used to probe which one you are holding. The client tells
    // them apart by re-attesting on any 401.
    return reply.code(401).send({ error: 'Invalid or expired token' })
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    deviceId?: string
  }
}
