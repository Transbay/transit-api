import type { FastifyInstance, FastifyReply } from 'fastify'
import { readSnapshot, readVehicles } from './snapshot.js'
import { loadBartGeometry } from './gtfs.js'
import type { MonitoredStopVisit } from './siri.js'

// A public BART board, for checking the position estimate against reality.
//
// Open, like `/health`: it reads only Redis and serves only public transit data, and it
// has to work in a browser on a platform with no token. Its reason to exist is
// falsifiability — a synthesized train position is an inference, and the only honest way
// to ship one is to make it easy to catch being wrong. So it shows the seconds, both
// sources side by side, and where we think the train physically is.

/** What people type versus what BART calls it. */
const LINES: Record<string, { name: string; hex: string }> = {
  yl: { name: 'Yellow', hex: 'ffff33' },
  yellow: { name: 'Yellow', hex: 'ffff33' },
  rd: { name: 'Red', hex: 'ff0000' },
  red: { name: 'Red', hex: 'ff0000' },
  gn: { name: 'Green', hex: '339933' },
  green: { name: 'Green', hex: '339933' },
  bl: { name: 'Blue', hex: '0099cc' },
  blue: { name: 'Blue', hex: '0099cc' },
  or: { name: 'Orange', hex: 'ff9933' },
  orange: { name: 'Orange', hex: 'ff9933' },
  be: { name: 'Beige', hex: '9a8768' },
  beige: { name: 'Beige', hex: '9a8768' },
}

/**
 * BART runs north/south. Platform signs and memory say otherwise, so east/west are
 * accepted and ignored rather than 404'd — being pedantic at someone standing on a
 * platform is not a feature.
 */
const DIRECTIONS: Record<string, 'N' | 'S' | null> = {
  n: 'N', nb: 'N', north: 'N', northbound: 'N',
  s: 'S', sb: 'S', south: 'S', southbound: 'S',
  e: null, eb: null, east: null, eastbound: null,
  w: null, wb: null, west: null, westbound: null,
}

interface Departure {
  destination: string
  line: string
  /** Epoch milliseconds — the page counts down from this itself, once a second. */
  epochMs: number
  platform: string | null
  cars: number | null
  delaySeconds: number | null
  leaving: boolean
  trainId: string | null
}

interface TrainView {
  id: string
  line: string
  destination: string
  lat: number
  lon: number
  bearing: number | null
  speedMs: number
  nextStop: string | null
  confidence: string
  source: string
}

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const inner = (v as Record<string, unknown>).value
    if (typeof inner === 'string') return inner
  }
  return ''
}

function toDeparture(visit: MonitoredStopVisit): Departure | null {
  const j = visit.MonitoredVehicleJourney as Record<string, unknown> | undefined
  if (!j) return null
  const call = (j.MonitoredCall ?? {}) as Record<string, unknown>
  const raw = (call.ExpectedDepartureTime ?? call.ExpectedArrivalTime) as string | undefined
  if (!raw) return null
  const epochMs = Date.parse(raw)
  if (Number.isNaN(epochMs)) return null

  const ext = (j.Extensions ?? {}) as Record<string, unknown>
  return {
    destination: str(j.DestinationName),
    line: str(j.PublishedLineName) || str(j.LineRef),
    epochMs,
    platform: call.DeparturePlatformName ? String(call.DeparturePlatformName) : null,
    cars: typeof ext.TrainLength === 'number' ? ext.TrainLength : null,
    delaySeconds: typeof ext.DelaySeconds === 'number' ? ext.DelaySeconds : null,
    leaving: ext.Leaving === true,
    trainId: str(j.FramedVehicleJourneyRef
      ? ((j.FramedVehicleJourneyRef as Record<string, unknown>).DatedVehicleJourneyRef ?? '')
      : ''),
  }
}

export async function registerBartBoard(app: FastifyInstance): Promise<void> {
  async function build(stationCode: string, lineKey?: string, dirKey?: string) {
    const tables = await loadBartGeometry()
    const abbr = stationCode.toUpperCase()
    const station = tables.stations.get(abbr)

    if (!station) {
      return {
        error: `Unknown BART station "${stationCode}".`,
        stations: [...tables.stations.values()]
          .map((s) => ({ abbr: s.abbr, name: s.name }))
          .sort((a, b) => a.abbr.localeCompare(b.abbr)),
      }
    }

    const line = lineKey ? LINES[lineKey.toLowerCase()] : undefined
    const lineUnknown = Boolean(lineKey) && !line

    let direction: 'N' | 'S' | null = null
    let directionIgnored = false
    if (dirKey) {
      const key = dirKey.toLowerCase()
      if (key in DIRECTIONS) {
        direction = DIRECTIONS[key]
        // e/w are in the table mapped to null: accepted, but they mean nothing here.
        if (direction === null) directionIgnored = true
      }
    }

    // Departures across every platform of the station.
    const departures: Departure[] = []
    let ageSeconds: number | null = null
    for (const stopId of station.stopIds) {
      const snap = await readSnapshot('BA', stopId)
      if (!snap) continue
      ageSeconds = ageSeconds === null ? snap.ageSeconds : Math.min(ageSeconds, snap.ageSeconds)
      for (const v of snap.response.ServiceDelivery?.StopMonitoringDelivery
        ?.MonitoredStopVisit ?? []) {
        const d = toDeparture(v)
        if (d) departures.push(d)
      }
    }

    const filtered = departures
      .filter((d) => (line ? d.line.toLowerCase().includes(line.name.toLowerCase()) : true))
      .filter((d) =>
        direction ? d.line.toUpperCase().endsWith(`-${direction}`) : true,
      )
      .sort((a, b) => a.epochMs - b.epochMs)

    // The trains we believe are out there, nearest first — this is the half that makes
    // the estimate checkable rather than merely plausible.
    const stored = await readVehicles('BA')
    const trains: TrainView[] = []
    for (const v of (stored?.vehicles ?? []) as Record<string, unknown>[]) {
      const lineName = String(v.lineName ?? '')
      if (line && !lineName.toLowerCase().includes(line.name.toLowerCase())) continue
      // BART encodes direction as a suffix on the line ("Yellow-N"), so asking for
      // northbound departures should not list southbound trains beside them.
      if (direction && !lineName.toUpperCase().endsWith(`-${direction}`)) continue
      trains.push({
        id: String(v.id ?? ''),
        line: String(v.lineName ?? ''),
        destination: String(v.destination ?? ''),
        lat: Number(v.lat),
        lon: Number(v.lon),
        bearing: typeof v.bearing === 'number' ? v.bearing : null,
        speedMs: Number(v.speed ?? 0),
        nextStop: v.nextStop ? String(v.nextStop) : null,
        confidence: String(v.confidence ?? 'unknown'),
        source: String(v.source ?? 'unknown'),
      })
    }

    return {
      station: { abbr: station.abbr, name: station.name },
      line: line?.name ?? null,
      lineUnknown,
      direction,
      directionIgnored,
      ageSeconds,
      vehicleAgeSeconds: stored?.ageSeconds ?? null,
      serverNowMs: Date.now(),
      departures: filtered,
      trains: trains.slice(0, 12),
    }
  }

  function wantsJSON(accept: string | undefined): boolean {
    return Boolean(accept && accept.includes('application/json'))
  }

  async function handle(parts: string[], accept: string | undefined, reply: FastifyReply) {
    // The station is always last; anything before it is an optional line then direction.
    const station = parts[parts.length - 1]
    const lineKey = parts.length >= 2 ? parts[0] : undefined
    const dirKey = parts.length >= 3 ? parts[1] : undefined

    const data = await build(station, lineKey, dirKey)
    if (wantsJSON(accept)) {
      if ('error' in data) return reply.code(404).send(data)
      return data
    }
    reply.header('content-type', 'text/html; charset=utf-8')
    return renderPage(data)
  }

  app.get<{ Params: { a: string } }>('/bart/:a', async (req, reply) =>
    handle([req.params.a], req.headers.accept, reply),
  )
  app.get<{ Params: { a: string; b: string } }>('/bart/:a/:b', async (req, reply) =>
    handle([req.params.a, req.params.b], req.headers.accept, reply),
  )
  app.get<{ Params: { a: string; b: string; c: string } }>(
    '/bart/:a/:b/:c',
    async (req, reply) =>
      handle([req.params.a, req.params.b, req.params.c], req.headers.accept, reply),
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

function renderPage(data: Record<string, unknown>): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  const title =
    'error' in data
      ? 'Unknown station'
      : `${esc(String((data.station as { name: string }).name))} · BART`

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark light; --bg:#0d0f12; --fg:#e8eaed; --dim:#9aa0a6; --line:#232830; --ok:#5bd07a; --warn:#ffcc44; }
  * { box-sizing:border-box }
  body { margin:0; padding:16px; background:var(--bg); color:var(--fg);
         font:15px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
  h1 { font-size:17px; margin:0 0 2px; letter-spacing:.02em }
  .sub { color:var(--dim); font-size:13px; margin-bottom:16px }
  table { width:100%; border-collapse:collapse; margin-bottom:22px }
  th { text-align:left; font-weight:500; color:var(--dim); font-size:11px;
       text-transform:uppercase; letter-spacing:.08em; padding:0 8px 6px 0; border-bottom:1px solid var(--line) }
  td { padding:7px 8px 7px 0; border-bottom:1px solid var(--line); vertical-align:top }
  .cd { font-variant-numeric:tabular-nums; font-size:19px; font-weight:600 }
  .now { color:var(--ok) }
  .late { color:var(--warn) }
  .dim { color:var(--dim); font-size:12px }
  .train { border:1px solid var(--line); border-radius:6px; padding:10px 12px; margin-bottom:8px }
  .train b { font-weight:600 }
  .grid { display:grid; grid-template-columns:auto 1fr; gap:2px 14px; font-size:12.5px; margin-top:6px }
  .grid span:nth-child(odd) { color:var(--dim) }
  .foot { color:var(--dim); font-size:11.5px; margin-top:20px; line-height:1.7 }
  .stale { background:#3a2a12; border:1px solid #7a5a20; color:var(--warn);
           padding:8px 11px; border-radius:6px; margin-bottom:14px; font-size:13px }
  .doubt { opacity:.45 }
  .err { color:var(--warn) }
  code { background:#1a1e24; padding:1px 5px; border-radius:3px }
</style>
</head><body>
<div id="root">loading…</div>
<script>
const DATA = ${json};
function pad(n){ return String(n).padStart(2,'0') }
// Floor, not round: BART calls the last 60 seconds "Leaving", and so do we.
function countdown(ms){
  const s = Math.floor(ms/1000);
  if (s <= 0) return 'Now';
  return Math.floor(s/60) + ':' + pad(s%60);
}
// How long since data we know to be current. A countdown drawn from a frozen fetch is
// the same confident lie the position estimates are careful not to tell, so past these
// thresholds the page says so instead of ticking on regardless.
const REFRESH_WARN_S = 40;   // ~2 missed refreshes
const BOARD_WARN_S = 120;    // the snapshot itself has gone quiet

function staleness(){
  const sinceFetch = Math.floor((Date.now() - DATA.lastOkAt) / 1000);
  const boardAge = (DATA.ageSeconds ?? 0) + sinceFetch;
  if (DATA.lastError) return { bad:true, msg:'Cannot reach the server — '+DATA.lastError
    + '. Showing data from '+sinceFetch+'s ago.' };
  if (sinceFetch > REFRESH_WARN_S) return { bad:true,
    msg:'Not refreshing — last update '+sinceFetch+'s ago. Times below are stale.' };
  if (boardAge > BOARD_WARN_S) return { bad:true,
    msg:'Server is reachable but its BART data is '+boardAge+'s old. Times below are stale.' };
  return { bad:false };
}

function render(){
  const r = document.getElementById('root');
  if (DATA.error){
    r.innerHTML = '<h1 class="err">'+DATA.error+'</h1><div class="sub">Valid station codes:</div>'
      + '<div class="dim">' + DATA.stations.map(s=>'<code>'+s.abbr.toLowerCase()+'</code> '+s.name).join('<br>') + '</div>';
    return;
  }
  // Trust the server's clock, not the phone's: an unsynced device would otherwise make
  // a perfectly good estimate look broken.
  const skew = DATA.clientLoadedAt - DATA.serverNowMs;
  const now = Date.now() - skew;

  const st = staleness();
  let h = '<h1>'+DATA.station.name+' · '+DATA.station.abbr+'</h1><div class="sub">'
    + (DATA.line ? DATA.line+' line' : 'all lines')
    + (DATA.direction ? ' · '+(DATA.direction==='N'?'Northbound':'Southbound') : '')
    + ' · board '+(DATA.ageSeconds==null?'—':DATA.ageSeconds+'s old')
    + '</div>';

  if (st.bad) h += '<div class="stale">⚠ '+st.msg+'</div>';
  if (DATA.lineUnknown) h += '<div class="sub err">Unknown line — showing all.</div>';
  if (DATA.directionIgnored) h += '<div class="sub err">BART runs north/south; direction ignored.</div>';

  h += '<table'+(st.bad?' class="doubt"':'')+'><tr><th>in</th><th>to</th><th>line</th><th>plat</th><th>cars</th></tr>';
  if (!DATA.departures.length) h += '<tr><td colspan="5" class="dim">No departures.</td></tr>';
  for (const d of DATA.departures.slice(0,10)){
    const left = d.epochMs - now;
    // Don't paint a stale countdown green as though it were live.
    const cls = (left <= 0 && !st.bad) ? 'cd now' : 'cd';
    h += '<tr><td class="'+cls+'">'+countdown(left)+'</td>'
      + '<td>'+d.destination+(d.leaving?' <span class="dim">leaving</span>':'')+'</td>'
      + '<td class="dim">'+d.line+'</td>'
      + '<td class="dim">'+(d.platform??'—')+'</td>'
      + '<td class="dim">'+(d.cars??'—')
      + (d.delaySeconds ? ' <span class="late">+'+Math.round(d.delaySeconds/60)+'m</span>' : '')
      + '</td></tr>';
  }
  h += '</table>';

  h += '<div class="sub'+(st.bad?' doubt':'')+'">Trains — positions are ESTIMATED, not reported'
     + (DATA.vehicleAgeSeconds!=null?' · '+DATA.vehicleAgeSeconds+'s old':'')+'</div>';
  if (!DATA.trains.length) h += '<div class="dim">No trains.</div>';
  for (const t of DATA.trains){
    h += '<div class="train"><b>'+t.line+'</b> → '+t.destination
      + ' <span class="dim">#'+t.id+'</span>'
      + '<div class="grid">'
      + '<span>position</span><span>'+t.lat.toFixed(5)+', '+t.lon.toFixed(5)+'</span>'
      + '<span>speed</span><span>'+t.speedMs.toFixed(1)+' m/s ('+(t.speedMs*2.237).toFixed(0)+' mph)'
      + (t.bearing!=null?' · bearing '+Math.round(t.bearing)+'°':'')+'</span>'
      + '<span>next</span><span>'+(t.nextStop??'—')+'</span>'
      + '<span>quality</span><span>'+t.source+' · '+t.confidence+'</span>'
      + '</div></div>';
  }

  h += '<div class="foot">Counting down by the second. Departures refresh every 15s.<br>'
     + 'Train positions are interpolated between predicted stop times — BART publishes no '
     + 'vehicle locations. Compare against what you actually see.</div>';
  r.innerHTML = h;
}
DATA.clientLoadedAt = Date.now();
DATA.lastOkAt = Date.now();
DATA.lastError = null;
render();
setInterval(render, 1000);
setInterval(async () => {
  try {
    const res = await fetch(location.pathname, { headers: { accept: 'application/json' } });
    if (!res.ok) { DATA.lastError = 'HTTP ' + res.status; return; }
    const fresh = await res.json();
    Object.assign(DATA, fresh);
    DATA.clientLoadedAt = Date.now();
    DATA.lastOkAt = Date.now();
    DATA.lastError = null;
  } catch (e) {
    // A dead server must not look like a live one. Swallowing this is what let a frozen
    // board tick confidently for five minutes.
    DATA.lastError = 'connection failed';
  }
}, 15000);
</script>
</body></html>`
}
