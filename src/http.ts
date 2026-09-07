// Plain HTTP transport, knowing nothing about API keys.
//
// `upstream.ts` is built so that it is impossible to reach 511 without booking the
// request against the hourly budget. BART's endpoints are free and must not touch that
// budget, so they need a second path — and the guard below is what keeps adding one
// from quietly becoming a hole in the first.

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'UpstreamError'
  }
}

/**
 * 511 sends JSON with a UTF-8 byte-order mark, which `JSON.parse` rejects outright.
 * BART's legacy API has the same habit, so the strip lives here rather than in either
 * caller.
 */
function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Refuses to fetch 511 through the keyless path.
 *
 * Every 511 request must go through `upstream.ts` so it gets counted; a request made
 * here would spend the real allowance without the budget ever knowing, and the first
 * symptom would be unexplained 429s. Two lines, and the mistake becomes impossible
 * rather than merely discouraged.
 */
function assertNotMetered(url: URL): void {
  if (url.hostname === 'api.511.org') {
    throw new Error(
      `Refusing to fetch ${url.pathname} through http.ts: 511 requests must go through ` +
        `upstream.ts so they are counted against the key budget.`,
    )
  }
}

interface GetOptions {
  timeoutMs: number
  /** Used in errors and logs. Never include a URL — some carry keys. */
  label: string
}

async function get(url: URL | string, { timeoutMs, label }: GetOptions): Promise<Response> {
  const target = typeof url === 'string' ? new URL(url) : url
  assertNotMetered(target)

  let response: Response
  try {
    response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    throw new UpstreamError(`${label} request failed: ${(err as Error).message}`, 502)
  }

  if (!response.ok) {
    throw new UpstreamError(`${label} returned HTTP ${response.status}`, 502)
  }
  return response
}

export async function httpGetJSON<T>(url: URL | string, opts: GetOptions): Promise<T> {
  const response = await get(url, opts)
  const text = await response.text()
  try {
    return JSON.parse(stripBOM(text)) as T
  } catch (err) {
    throw new UpstreamError(
      `Could not parse ${opts.label} response: ${(err as Error).message}`,
      502,
    )
  }
}

export async function httpGetBytes(url: URL | string, opts: GetOptions): Promise<Uint8Array> {
  const response = await get(url, opts)
  return new Uint8Array(await response.arrayBuffer())
}
