import type { FastifyInstance } from 'fastify'
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { config } from './config.js'

/**
 * MapKit JS authorisation tokens.
 *
 * MapKit JS will not initialise without a short-lived ES256 JWT signed by a key from the
 * Apple Developer portal. The signing key is a private key, so the browser cannot hold it
 * and this endpoint exists to mint tokens on its behalf.
 *
 * Two details are easy to get wrong and both fail the same way -- a map that silently never
 * loads:
 *
 * 1. **The signature must be in JOSE form**, the raw 64-byte `r || s`. Node signs ECDSA in
 *    DER by default, which is a perfectly valid signature that every JWT verifier rejects.
 *    `dsaEncoding: 'ieee-p1363'` is the whole fix and it is one word.
 * 2. **The `origin` claim cannot come from the request.** It restricts which page may use
 *    the token, which is the only thing standing between an open page and somebody else
 *    spending the Maps quota. Deriving it from the Host or Origin header would hand any
 *    caller a token scoped to whatever they asked for, which is not a restriction at all.
 *    So it is an allowlist, and a request from anywhere else is refused.
 *
 * Configuration is optional throughout. Without a key the endpoint reports that maps are
 * disabled and the pages fall back to their tables, because a missing map is a worse page
 * and a failed boot is a worse day.
 */

export function mapkitConfigured(): boolean {
  const { keyId, teamId, privateKey } = config.mapkit
  return Boolean(keyId && teamId && privateKey)
}

let cachedKey: KeyObject | null = null
let keyError: string | null = null

function privateKeyObject(): KeyObject | null {
  if (cachedKey) return cachedKey
  if (keyError) return null
  try {
    cachedKey = createPrivateKey(config.mapkit.privateKey)
    return cachedKey
  } catch (err) {
    // Recorded once rather than thrown per request: a malformed key is a deployment
    // mistake, and every request producing the same stack trace buries it.
    keyError = (err as Error).message
    console.error('[mapkit] private key could not be parsed:', keyError)
    return null
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Cached per origin: signing is cheap but not free, and every viewer asks. */
const tokens = new Map<string, { token: string; expiresAt: number }>()

export function mintToken(origin: string, now = Date.now()): string | null {
  const cached = tokens.get(origin)
  // Re-mint a minute early so nobody is handed a token that expires in transit.
  if (cached && cached.expiresAt - 60_000 > now) return cached.token

  const key = privateKeyObject()
  if (!key) return null

  const issuedAt = Math.floor(now / 1000)
  const expiresAt = issuedAt + config.mapkit.ttlSeconds

  const header = b64url(
    JSON.stringify({ alg: 'ES256', kid: config.mapkit.keyId, typ: 'JWT' }),
  )
  const payload = b64url(
    JSON.stringify({ iss: config.mapkit.teamId, iat: issuedAt, exp: expiresAt, origin }),
  )
  const signingInput = `${header}.${payload}`

  // ieee-p1363 is the raw r||s pair JWT requires. The default, DER, is a valid ECDSA
  // signature that MapKit will reject without explanation.
  const signature = sign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  })

  const token = `${signingInput}.${b64url(signature)}`
  tokens.set(origin, { token, expiresAt: expiresAt * 1000 })
  return token
}

/** The origin to sign for, or null when the caller is not on the allowlist. */
export function resolveOrigin(requestOrigin: string | undefined): string | null {
  const allowed = config.mapkit.origins
  if (allowed.length === 0) return null
  if (!requestOrigin) return allowed[0]
  return allowed.includes(requestOrigin) ? requestOrigin : null
}

export function mapkitStatus(): Record<string, unknown> {
  return {
    configured: mapkitConfigured(),
    keyId: config.mapkit.keyId ? `${config.mapkit.keyId.slice(0, 4)}…` : null,
    origins: config.mapkit.origins,
    ttlSeconds: config.mapkit.ttlSeconds,
    keyError,
  }
}

export async function registerMapkit(app: FastifyInstance): Promise<void> {
  /**
   * Open, like the pages that use it. The token is origin-restricted and short-lived, which
   * is the actual protection; requiring attestation here would only stop the dashboard from
   * working in a browser, which is the one place it needs to.
   */
  app.get('/v1/mapkit/token', async (request, reply) => {
    if (!mapkitConfigured()) {
      return reply.code(503).send({ error: 'maps are not configured' })
    }
    const origin = resolveOrigin(request.headers.origin)
    if (!origin) {
      return reply.code(403).send({ error: 'origin not allowed' })
    }
    const token = mintToken(origin)
    if (!token) {
      return reply.code(500).send({ error: 'token could not be signed' })
    }
    // Private: the token is scoped to one origin and a shared cache would serve it to
    // pages that are not.
    reply.header('cache-control', 'private, max-age=60')
    reply.header('content-type', 'text/plain; charset=utf-8')
    return token
  })
}
