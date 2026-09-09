import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decode as cborDecode } from 'cbor-x'
import * as x509 from '@peculiar/x509'
import { config } from './config.js'

// @peculiar/x509 needs an explicit WebCrypto implementation for signature checks.
// Node has one built in; wiring it up here rather than relying on a global keeps the
// behaviour identical whatever Node version Railway happens to run.
x509.cryptoProvider.set(webcrypto as unknown as Crypto)

/** Verifies Apple App Attest attestations. */

/** Apple's App Attest root, the trust anchor for the whole check. */
const rootCertPath = fileURLToPath(
  new URL('../certs/Apple_App_Attestation_Root_CA.pem', import.meta.url),
)

let rootCert: x509.X509Certificate
try {
  rootCert = new x509.X509Certificate(readFileSync(rootCertPath, 'utf8'))
} catch (err) {
  throw new Error(
    `Could not load Apple's App Attest root CA from ${rootCertPath}. ` +
      `Download it with:\n  curl -o certs/Apple_App_Attestation_Root_CA.pem ` +
      `https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem\n` +
      `Original error: ${(err as Error).message}`,
  )
}

/** The OID of the Apple extension carrying the nonce we challenged the device with. */
const NONCE_EXTENSION_OID = '1.2.840.113635.100.8.2'

export class AttestationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttestationError'
  }
}

function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

/**
 * The CBOR blob Apple's `attestKey` hands back, once decoded.
 * `x5c` is a certificate chain: [device leaf, Apple intermediate].
 */
interface AttestationObject {
  fmt: string
  attStmt: { x5c: Buffer[]; receipt: Buffer }
  authData: Buffer
}

/** Digs the 32-byte nonce out of Apple's custom certificate extension. */
function extractNonce(leaf: x509.X509Certificate): Buffer {
  const extension = leaf.getExtension(NONCE_EXTENSION_OID)
  if (!extension) {
    throw new AttestationError('Leaf certificate is missing the Apple nonce extension')
  }

  const bytes = Buffer.from(extension.value)
  for (let i = 0; i + 34 <= bytes.length; i++) {
    if (bytes[i] === 0x04 && bytes[i + 1] === 0x20) {
      return bytes.subarray(i + 2, i + 34)
    }
  }
  throw new AttestationError('Could not locate the nonce inside the Apple extension')
}

/**
 * Parses the WebAuthn-style authenticator data that rides along with the attestation.
 *
 * Layout: 32 bytes rpIdHash, 1 byte flags, 4 bytes counter, then attested credential
 * data — 16 bytes AAGUID, 2 bytes credential ID length, then the credential ID.
 */
function parseAuthData(authData: Buffer) {
  if (authData.length < 55) {
    throw new AttestationError('Authenticator data is too short to be valid')
  }
  const rpIdHash = authData.subarray(0, 32)
  const counter = authData.readUInt32BE(33)
  const aaguid = authData.subarray(37, 53)
  const credentialIdLength = authData.readUInt16BE(53)
  const credentialId = authData.subarray(55, 55 + credentialIdLength)
  return { rpIdHash, counter, aaguid, credentialId }
}

/** Verifies one attestation. */
export async function verifyAttestation(
  attestationBase64: string,
  keyIdBase64: string,
  challenge: string,
): Promise<{ keyId: string }> {
  let attestation: AttestationObject
  try {
    attestation = cborDecode(Buffer.from(attestationBase64, 'base64')) as AttestationObject
  } catch (err) {
    throw new AttestationError(`Attestation is not valid CBOR: ${(err as Error).message}`)
  }

  if (attestation.fmt !== 'apple-appattest') {
    throw new AttestationError(`Unexpected attestation format: ${attestation.fmt}`)
  }

  const x5c = attestation.attStmt?.x5c
  if (!Array.isArray(x5c) || x5c.length < 2) {
    throw new AttestationError('Attestation is missing its certificate chain')
  }

  const leaf = new x509.X509Certificate(new Uint8Array(x5c[0]))
  const intermediate = new x509.X509Certificate(new Uint8Array(x5c[1]))

  // --- 1. Chain of trust: leaf <- intermediate <- Apple's root. ---
  // Establishes that Apple's attestation CA vouched for this specific device key.
  // Everything downstream is meaningless without it, so it goes first.
  if (!(await leaf.verify({ publicKey: intermediate.publicKey }))) {
    throw new AttestationError('Leaf certificate was not signed by the intermediate')
  }
  if (!(await intermediate.verify({ publicKey: rootCert.publicKey }))) {
    throw new AttestationError('Intermediate certificate was not signed by Apple\'s root')
  }

  const now = new Date()
  for (const [name, cert] of [['leaf', leaf], ['intermediate', intermediate]] as const) {
    if (now < cert.notBefore || now > cert.notAfter) {
      throw new AttestationError(`The ${name} certificate is outside its validity window`)
    }
  }

  // --- 2. Freshness: the attestation answers *our* challenge. ---
  // This is what stops a replay. Without it, one captured attestation from one real
  // device could be resubmitted forever by anybody.
  const clientDataHash = sha256(Buffer.from(challenge, 'utf8'))
  const expectedNonce = sha256(attestation.authData, clientDataHash)
  const actualNonce = extractNonce(leaf)
  if (!expectedNonce.equals(actualNonce)) {
    throw new AttestationError('Attestation nonce does not match the issued challenge')
  }

  // --- 3. The key ID really is this certificate's key. ---
  // Binds the identity we are about to issue a token for to the attested key.
  // Apple hashes the *raw* elliptic-curve point (the 65-byte uncompressed form), not
  // the SPKI wrapper, so the key has to be re-exported rather than hashed as it sits
  // in the certificate.
  const cryptoKey = await leaf.publicKey.export(webcrypto as unknown as Crypto)
  const rawPublicKey = Buffer.from(await webcrypto.subtle.exportKey('raw', cryptoKey))
  const expectedKeyId = sha256(rawPublicKey)
  const providedKeyId = Buffer.from(keyIdBase64, 'base64')
  if (!expectedKeyId.equals(providedKeyId)) {
    throw new AttestationError('Key ID does not match the attested public key')
  }

  const { rpIdHash, counter, aaguid, credentialId } = parseAuthData(attestation.authData)

  // --- 4. It is *our* app, not merely *an* app. ---
  // The chain proves "a genuine Apple device running some attested app". This is the
  // step that makes it ours; skipping it would let any App Attest-enabled app on the
  // store spend our 511 budget.
  const appId = `${config.appAttest.teamId}.${config.appAttest.bundleId}`
  if (!sha256(Buffer.from(appId, 'utf8')).equals(rpIdHash)) {
    throw new AttestationError('Attestation was produced by a different app')
  }

  // A fresh attestation always reports zero; anything else means we were handed an
  // assertion counter rather than a first-time attestation.
  if (counter !== 0) {
    throw new AttestationError(`Expected a fresh attestation, but the counter was ${counter}`)
  }

  // --- 5. Production builds only, unless explicitly allowed. ---
  const environment = aaguid.toString('utf8').replace(/\0+$/, '')
  if (environment === 'appattestdevelop') {
    if (!config.appAttest.allowDevelopmentAttestations) {
      throw new AttestationError(
        'Development attestation rejected; set ALLOW_DEV_ATTESTATION=true only on a dev deploy',
      )
    }
  } else if (environment !== 'appattest') {
    throw new AttestationError(`Unrecognised attestation environment: ${environment}`)
  }

  if (!credentialId.equals(providedKeyId)) {
    throw new AttestationError('Credential ID does not match the supplied key ID')
  }

  return { keyId: keyIdBase64 }
}
