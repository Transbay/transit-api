import { config } from './config.js'
import { reserveKey } from './keypool.js'
import { UpstreamError } from './http.js'

// The only module that holds a 511 key. Every function here reserves one first, so a
// request that isn't counted against the budget cannot be made by accident.

// Re-exported so `routes.ts` and its error handler keep importing it from here.
export { UpstreamError } from './http.js'

/** 511 sends JSON with a UTF-8 byte-order mark, which `JSON.parse` rejects outright. */
function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** One GET against the 511 transit API, returning the raw `Response`. */
async function request(
  path: string,
  query: Record<string, string>,
  { json, timeoutMs }: { json: boolean; timeoutMs: number },
): Promise<Response> {
  const { key, index } = await reserveKey()

  const url = new URL(path, config.fiveEleven.baseUrl)
  url.searchParams.set('api_key', key)
  // Protobuf and zip endpoints have no format parameter, and sending one to them is
  // at best ignored.
  if (json) url.searchParams.set('format', 'json')
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value)
  }

  const abort = AbortSignal.timeout(timeoutMs)

  let response: Response
  try {
    response = await fetch(url, { signal: abort })
  } catch (err) {
    // Log the path and which key was used — never the URL, which carries the key.
    console.error(`[upstream] ${path} failed on key #${index}:`, (err as Error).message)
    throw new UpstreamError(`511 request failed: ${(err as Error).message}`, 502)
  }

  if (response.status === 429) {
    // We overspent our own accounting somehow — worth shouting about, because it
    // means the budget counter and 511's disagree.
    console.error(`[upstream] 429 on key #${index}; local budget believed it had room`)
    throw new UpstreamError('511 rate limit hit', 429)
  }

  if (!response.ok) {
    throw new UpstreamError(`511 returned HTTP ${response.status}`, 502)
  }

  return response
}

/**
 * A JSON endpoint. Unchanged in behaviour from before the GTFS-RT work — the
 * reference endpoints and the on-demand departure fallback still use this.
 */
export async function fetchUpstream<T>(
  path: string,
  query: Record<string, string>,
): Promise<T> {
  // A slow 511 must not pin a request open indefinitely; the widget that triggered
  // this has its own deadline and would rather have stale data than a hung socket.
  const response = await request(path, query, { json: true, timeoutMs: 10_000 })
  const text = await response.text()
  try {
    return JSON.parse(stripBOM(text)) as T
  } catch (err) {
    throw new UpstreamError(`Could not parse 511 response: ${(err as Error).message}`, 502)
  }
}

/** A protobuf endpoint (`tripupdates`, `vehiclepositions`), as bytes. */
export async function fetchUpstreamProtobuf(
  path: string,
  query: Record<string, string>,
): Promise<Uint8Array> {
  const response = await request(path, query, { json: false, timeoutMs: 30_000 })
  return new Uint8Array(await response.arrayBuffer())
}

/** A binary endpoint streamed rather than buffered — the 60 MB static GTFS archive. */
export async function fetchUpstreamRaw(
  path: string,
  query: Record<string, string>,
): Promise<ReadableStream<Uint8Array>> {
  const response = await request(path, query, { json: false, timeoutMs: 120_000 })
  if (!response.body) throw new UpstreamError('511 returned an empty body', 502)
  return response.body
}
