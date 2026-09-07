import type { FastifyInstance, FastifyReply } from 'fastify'
import { readSnapshot, knownAgencies } from './snapshot.js'
import { loadStopTable } from './gtfs.js'
import type { MonitoredStopVisit } from './siri.js'
import { page, esc, jsonLiteral } from './chrome.js'

/**
 * A departure board for any operator, at any stop.
 *
 * `/bart/:station` existed first and stays, because BART needs things no other agency does:
 * station codes rather than stop ids, several platforms folded into one board, and the
 * synthesized train positions that page was built to let you falsify from the platform.
 *
 * Everything else needs none of that. A board is the snapshot for one stop, rendered -- so
 * this serves all two dozen operators from the same code, addressed the way a rider would:
 *
 *     /sf/15419          every departure from that stop
 *     /sf/14/15419       just the 14
 *
 * The agency is validated against the operators we have actually written a snapshot for,
 * which is what keeps a two-segment catch-all from swallowing unrelated paths. Fastify
 * already prefers static segments, so `/v1/...`, `/bart/...`, `/analysis/...` and `/dash/...`
 * are matched by their own routes before this one is considered.
 */

interface Departure {
  line: string
  destination: string
  epochMs: number
  platform: string | null
  vehicle: string | null
  /** Present only where the producer publishes it; BART does, most do not. */
  delaySeconds: number | null
  occupancy: string | null
}

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
  if (v && typeof v === 'object') {
    const value = (v as Record<string, unknown>).value
    if (typeof value === 'string') return value
  }
  return ''
}

function toDeparture(visit: MonitoredStopVisit): Departure | null {
  const j = visit.MonitoredVehicleJourney as Record<string, unknown> | undefined
  if (!j) return null
  const call = (j.MonitoredCall ?? {}) as Record<string, unknown>
  const raw = (call.ExpectedDepartureTime ??
    call.ExpectedArrivalTime ??
    call.AimedDepartureTime ??
    call.AimedArrivalTime) as string | undefined
  if (!raw) return null
  const epochMs = Date.parse(raw)
  if (Number.isNaN(epochMs)) return null

  const ext = (j.Extensions ?? {}) as Record<string, unknown>
  return {
    line: str(j.PublishedLineName) || str(j.LineRef),
    destination: str(j.DestinationName),
    epochMs,
    platform: call.DeparturePlatformName ? String(call.DeparturePlatformName) : null,
    vehicle: str(j.VehicleRef) || null,
    delaySeconds: typeof ext.DelaySeconds === 'number' ? ext.DelaySeconds : null,
    occupancy: str(j.Occupancy) || null,
  }
}

interface BoardData {
  agency: string
  stopCode: string
  stopName: string | null
  routeFilter: string | null
  ageSeconds: number | null
  generatedAt: string
  departures: Departure[]
  /** Every line at this stop, so the page can offer them rather than make you guess. */
  lines: string[]
}

async function build(
  agency: string,
  stopCode: string,
  routeFilter: string | null,
): Promise<BoardData | { error: string; agencies: string[] }> {
  const known = await knownAgencies()
  const upper = agency.toUpperCase()
  if (!known.includes(upper)) {
    return { error: `No snapshot for operator "${agency}".`, agencies: known }
  }

  const snap = await readSnapshot(upper, stopCode)
  const visits = snap?.response.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit ?? []

  const all: Departure[] = []
  for (const v of visits) {
    const d = toDeparture(v)
    if (d) all.push(d)
  }
  all.sort((a, b) => a.epochMs - b.epochMs)

  const lines = [...new Set(all.map((d) => d.line).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  )

  const wanted = routeFilter?.toLowerCase()
  const departures = wanted ? all.filter((d) => d.line.toLowerCase() === wanted) : all

  let stopName: string | null = null
  try {
    const stops = await loadStopTable()
    // The static table is keyed by agency-qualified stop id; the snapshot by stop code.
    stopName = stops.get(`${upper}:${stopCode}`)?.name ?? stops.get(stopCode)?.name ?? null
  } catch {
    // A board without a stop name is still a board.
  }

  return {
    agency: upper,
    stopCode,
    stopName,
    routeFilter,
    ageSeconds: snap?.ageSeconds ?? null,
    generatedAt: new Date().toISOString(),
    departures,
    lines,
  }
}

function wantsJSON(accept: string | undefined): boolean {
  return Boolean(accept && accept.includes('application/json') && !accept.includes('text/html'))
}

export async function registerBoard(app: FastifyInstance): Promise<void> {
  async function handle(
    agency: string,
    stopCode: string,
    routeFilter: string | null,
    accept: string | undefined,
    reply: FastifyReply,
  ) {
    const data = await build(agency, stopCode, routeFilter)
    if ('error' in data) return reply.code(404).send(data)
    if (wantsJSON(accept)) return data
    reply.header('content-type', 'text/html; charset=utf-8')
    return renderBoard(data)
  }

  /** The JSON the page refreshes itself from. Named so it cannot collide with a stop code. */
  app.get<{ Querystring: { agency?: string; stop?: string; route?: string } }>(
    '/v1/board',
    async (request, reply) => {
      const { agency = '', stop = '', route } = request.query
      if (!agency || !stop) return reply.code(400).send({ error: 'agency and stop required' })
      const data = await build(agency, stop, route ?? null)
      if ('error' in data) return reply.code(404).send(data)
      return data
    },
  )

  app.get<{ Params: { agency: string; stop: string } }>(
    '/:agency/:stop',
    async (request, reply) =>
      handle(request.params.agency, request.params.stop, null, request.headers.accept, reply),
  )

  app.get<{ Params: { agency: string; route: string; stop: string } }>(
    '/:agency/:route/:stop',
    async (request, reply) =>
      handle(
        request.params.agency,
        request.params.stop,
        request.params.route,
        request.headers.accept,
        reply,
      ),
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const STYLE = `
.dep { display:grid; grid-template-columns:auto 1fr auto; gap:.9rem; align-items:center;
       padding:.8rem 0; border-bottom:1px solid var(--edge); }
.dep:last-child { border-bottom:none; }
.line { font-family:var(--font-display); font-weight:700; font-size:1rem;
        min-width:3.1rem; padding:.3rem .55rem; border-radius:9px; text-align:center;
        background:color-mix(in srgb, var(--accent) 18%, transparent);
        color:var(--accent-soft); border:1px solid #7DD3FC33; }
.dest { font-weight:500; }
.meta { color:var(--ink-faint); font-size:.76rem; margin-top:.1rem; }
.cd { font-family:var(--font-display); font-weight:600; font-size:1.45rem;
      font-variant-numeric:tabular-nums; text-align:right; min-width:4.2rem; }
.cd.now { color:var(--good); }
.cd.soon { color:var(--accent); }
.stale { border:1px solid #7a5a20; background:#3a2a1255; color:var(--warn);
         padding:.7rem .9rem; border-radius:12px; margin-bottom:1rem; font-size:.85rem; }
.lines { display:flex; flex-wrap:wrap; gap:.4rem; margin-top:.9rem; }
.lines a { font-size:.8rem; padding:.2rem .6rem; border:1px solid var(--edge);
           border-radius:999px; color:var(--ink-dim); }
.lines a.on { border-color:var(--accent); color:var(--accent); }
`

function renderBoard(d: BoardData): string {
  const title = d.stopName ? d.stopName : `${d.agency} ${d.stopCode}`
  const base = `/${d.agency.toLowerCase()}`

  const lineLinks = d.lines.length
    ? `<div class="lines">
        <a href="${base}/${esc(d.stopCode)}"${d.routeFilter ? '' : ' class="on"'}>all</a>` +
      d.lines
        .map(
          (l) =>
            `<a href="${base}/${encodeURIComponent(l)}/${esc(d.stopCode)}"${
              d.routeFilter && d.routeFilter.toLowerCase() === l.toLowerCase() ? ' class="on"' : ''
            }>${esc(l)}</a>`,
        )
        .join('') +
      `</div>`
    : ''

  const body = `
<div class="panel">
  <div id="stale"></div>
  <div id="deps"><p class="empty">loading…</p></div>
  ${lineLinks}
</div>
<p class="foot">
  Times are the operator's own predictions, republished — this page does not correct them.
  The countdown is computed in your browser from the last snapshot, so it keeps ticking after
  the data stops being refreshed; past about forty seconds it says so rather than counting
  down a number nobody stands behind.
  <br>Add <code>?</code>nothing — just append a line to the path to filter: <code>${esc(base)}/14/${esc(d.stopCode)}</code>.
</p>`

  const script = `
const D = ${jsonLiteral(d)};
const $ = (id) => document.getElementById(id);
let data = D, fetchedAt = Date.now();

function pad(n) { return String(n).padStart(2, '0'); }
function countdown(ms) {
  const s = Math.floor(ms / 1000);
  if (s <= 30) return 'Now';
  const m = Math.floor(s / 60);
  return m >= 60 ? Math.floor(m/60) + 'h' + pad(m%60) : m + ':' + pad(s % 60);
}

function draw() {
  const now = Date.now();
  const age = Math.round((now - fetchedAt) / 1000) + (data.ageSeconds || 0);
  $('stale').innerHTML = age > 90
    ? '<div class="stale">Data is ' + age + 's old — the feed or this page has stopped ' +
      'refreshing. Treat these times as indicative.</div>'
    : '';

  const rows = (data.departures || []).filter(d => d.epochMs - now > -60000);
  if (!rows.length) {
    $('deps').innerHTML = '<p class="empty">Nothing scheduled here right now.</p>';
    return;
  }
  $('deps').innerHTML = rows.slice(0, 20).map(d => {
    const ms = d.epochMs - now;
    const cls = ms <= 30000 ? 'now' : (ms <= 300000 ? 'soon' : '');
    const bits = [];
    if (d.platform) bits.push('Platform ' + d.platform);
    if (d.delaySeconds !== null && d.delaySeconds !== undefined && Math.abs(d.delaySeconds) >= 60)
      bits.push((d.delaySeconds > 0 ? '+' : '') + Math.round(d.delaySeconds / 60) + ' min');
    if (d.vehicle) bits.push('#' + d.vehicle);
    const t = new Date(d.epochMs);
    bits.push(pad(t.getHours()) + ':' + pad(t.getMinutes()));
    return '<div class="dep"><div class="line">' + (d.line || '—') + '</div>' +
      '<div><div class="dest">' + (d.destination || '—') + '</div>' +
      '<div class="meta">' + bits.join(' · ') + '</div></div>' +
      '<div class="cd ' + cls + '">' + countdown(ms) + '</div></div>';
  }).join('');
}

async function refresh() {
  const q = new URLSearchParams({ agency: data.agency, stop: data.stopCode });
  if (data.routeFilter) q.set('route', data.routeFilter);
  try {
    const next = await (await fetch('/v1/board?' + q, {cache:'no-store'})).json();
    if (next && next.departures) { data = next; fetchedAt = Date.now(); }
  } catch (e) { /* keep drawing the old data; the staleness banner will say so */ }
  draw();
}

draw();
setInterval(draw, 1000);
setInterval(refresh, 15000);
`

  return page(title, body, {
    subtitle:
      `${esc(d.agency)} · stop ${esc(d.stopCode)}` +
      (d.routeFilter ? ` · line ${esc(d.routeFilter)}` : '') +
      (d.stopName ? '' : ' · <span class="faint">no name in the static feed</span>'),
    headerRight:
      '<span class="pill"><span class="dot"></span>live</span>' +
      '<a class="pill" href="/dash">profiles</a>',
    style: STYLE,
    script,
  })
}
