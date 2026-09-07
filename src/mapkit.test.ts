import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'

/**
 * MapKit tokens, checked against a throwaway key.
 *
 * The bug worth a test here produces a token that looks entirely correct and is rejected
 * without explanation: Node signs ECDSA in DER by default, and JWT requires the raw
 * `r || s` pair. Both are valid signatures over the same bytes, so nothing fails locally --
 * the map simply never loads, in production, with no error anyone can search for.
 *
 * The length assertion is the sharp one. A JOSE P-256 signature is exactly 64 bytes; a DER
 * encoding of the same signature is 70-72 and varies with the values, so a single equality
 * catches the mistake permanently.
 */

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

// config reads the environment exactly once, at import, so this has to be in place before
// anything else in the service is loaded.
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.FIVEELEVEN_API_KEYS ??= 'test-key'
process.env.APPLE_TEAM_ID ??= 'TEAM123456'
process.env.APP_BUNDLE_ID ??= 'dev.transbay.test'
process.env.JWT_SECRET ??= 'test-secret'
process.env.MAPKIT_KEY_ID = 'CC8NVUQFK7'
process.env.MAPKIT_PRIVATE_KEY = pem
process.env.MAPKIT_ORIGINS = 'https://transitapi.transbay.dev,https://example.test'

const { mintToken, resolveOrigin, mapkitConfigured } = await import('./mapkit.js')

// Each test signs for its own origin. The token cache is keyed by origin and, correctly,
// ignores the injected clock -- so tests that share an origin would hand each other a
// cached token and pass or fail depending on their order.
function parts(token: string) {
  const [h, p, s] = token.split('.')
  const dec = (x: string) => JSON.parse(Buffer.from(x, 'base64url').toString())
  return { header: dec(h), payload: dec(p), signature: Buffer.from(s, 'base64url'), signed: `${h}.${p}` }
}

test('a key, a team and a private key are enough to be configured', () => {
  assert.equal(mapkitConfigured(), true)
})

test('the header carries ES256 and the key id Apple issued', () => {
  const { header } = parts(mintToken('https://header.test')!)
  assert.equal(header.alg, 'ES256')
  assert.equal(header.typ, 'JWT')
  assert.equal(header.kid, 'CC8NVUQFK7')
})

test('the payload issues from the team and is origin-scoped', () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  const { payload } = parts(mintToken('https://payload.test', now)!)
  assert.equal(payload.iss, 'TEAM123456')
  assert.equal(payload.origin, 'https://payload.test')
  assert.equal(payload.iat, Math.floor(now / 1000))
  assert.ok(payload.exp > payload.iat, 'expires after it is issued')
})

test('the signature is JOSE r||s, not DER', () => {
  // 64 bytes exactly. DER would be 70-72 and variable, and MapKit would reject it.
  const { signature } = parts(mintToken('https://jose.test', Date.UTC(2026, 8, 7, 13))!)
  assert.equal(signature.length, 64)
})

test('the signature actually verifies against the public key', () => {
  const { signature, signed } = parts(mintToken('https://verify.test', Date.UTC(2026, 8, 7, 14))!)
  const ok = verify('sha256', Buffer.from(signed), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)
  assert.equal(ok, true)
})

test('a token is reused until it is nearly expired, then re-minted', () => {
  const base = Date.UTC(2026, 8, 7, 15)
  const first = mintToken('https://reuse.test', base)
  const again = mintToken('https://reuse.test', base + 60_000)
  assert.equal(first, again, 'a still-valid token is not re-signed per request')

  const later = mintToken('https://reuse.test', base + 1_800_000)
  assert.notEqual(first, later, 'an expiring token is replaced')
})

test('each origin gets its own token', () => {
  const now = Date.UTC(2026, 8, 7, 16)
  assert.notEqual(
    mintToken('https://per-origin-a.test', now),
    mintToken('https://per-origin-b.test', now),
  )
})

test('origins outside the allowlist are refused, not quietly signed', () => {
  // This is the whole protection. An origin taken from the request would let any caller
  // mint a token scoped to a page they control, which restricts nothing at all.
  assert.equal(resolveOrigin('https://evil.test'), null)
  assert.equal(resolveOrigin('https://example.test'), 'https://example.test')
})

test('a request with no Origin header falls back to the first allowed origin', () => {
  assert.equal(resolveOrigin(undefined), 'https://transitapi.transbay.dev')
})
