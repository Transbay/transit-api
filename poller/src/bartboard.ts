import type { FastifyInstance, FastifyReply } from 'fastify'
import { readSnapshot, readVehicles } from './snapshot.js'
import { loadBartGeometry } from './gtfs.js'
import type { MonitoredStopVisit } from './siri.js'
import { page, esc, jsonLiteral } from './chrome.js'
import { annotateLearned, LEARNED_STYLE, type Learnable } from './learned.js'

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

interface Departure extends Learnable {
  destination: string
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
      const platform: Departure[] = []
      for (const v of snap.response.ServiceDelivery?.StopMonitoringDelivery
        ?.MonitoredStopVisit ?? []) {
        const d = toDeparture(v)
        if (d) platform.push(d)
      }
      // Per platform, because predictions are indexed per stop, and a station is several.
      await annotateLearned('BA', stopId, platform)
      departures.push(...platform)
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
      /** How many of the departures shown the profile moved; drives the purple banner. */
      corrected: filtered.filter((d) => d.correctedMs !== undefined).length,
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


const BART_STYLE = `
.cd { font-family:var(--font-display); font-weight:600; font-size:1.35rem;
      font-variant-numeric:tabular-nums; }
.now { color:var(--good); }
.late { color:var(--warn); }
.dim { color:var(--ink-faint); font-size:.78rem; }
.train { border:1px solid var(--edge); border-radius:12px; padding:.75rem .9rem;
         margin-bottom:.55rem; background:var(--panel-bg); }
.train b { font-weight:600; }
.grid { display:grid; grid-template-columns:auto 1fr; gap:2px 14px; font-size:.8rem;
        margin-top:.45rem; }
.grid span:nth-child(odd) { color:var(--ink-faint); }
.stale { border:1px solid #7a5a20; background:#3a2a1255; color:var(--warn);
         padding:.7rem .9rem; border-radius:12px; margin-bottom:1rem; font-size:.85rem; }
.doubt { opacity:.45; }
.err { color:var(--warn); }
code { font-family:var(--font-mono); background:#1a1e24; padding:1px 5px; border-radius:4px; }
table { width:100%; }
/* A correction is a claim about data the agency did not give us, so the row is tinted
   and edged rather than merely recoloured: it should be obviously ours at a glance. */
tr.learned td { background:#8B6BF012; }
tr.learned td:first-child { box-shadow:inset 3px 0 0 #8B6BF0; border-radius:8px 0 0 8px; }
tr.learned td:last-child { border-radius:0 8px 8px 0; }
` + LEARNED_STYLE

function renderPage(data: Record<string, unknown>): string {
  const json = jsonLiteral(data)
  const failed = 'error' in data
  const title = failed
    ? 'Unknown station'
    : String((data.station as { name: string }).name)

  const script = `const DATA = ${json};
function pad(n){ return String(n).padStart(2,'0') }
function clock(ms){ const t = new Date(ms); return pad(t.getHours())+':'+pad(t.getMinutes()) }
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
  if (DATA.corrected > 0) h += '<div class="banner learned"><span class="pdot"></span>'
    + '<span>We are using historical data to improve countdowns. '
    + DATA.corrected + ' of ' + DATA.departures.length + ' adjusted. '
    + '<a href="/how">How?</a></span></div>';

  h += '<table'+(st.bad?' class="doubt"':'')+'><tr><th>in</th><th>to</th><th>line</th><th>plat</th><th>cars</th></tr>';
  if (!DATA.departures.length) h += '<tr><td colspan="5" class="dim">No departures.</td></tr>';
  for (const d of DATA.departures.slice(0,10)){
    const learned = typeof d.correctedMs === 'number';
    const left = (learned ? d.correctedMs : d.epochMs) - now;
    // Don't paint a stale countdown green as though it were live.
    const cls = (left <= 0 && !st.bad) ? 'cd now' : (learned ? 'cd learned' : 'cd');
    h += '<tr'+(learned?' class="learned"':'')+'><td class="'+cls+'">'+countdown(left)
      + (learned ? '<span class="was">agency '+clock(d.epochMs)+'</span>' : '')+'</td>'
      + '<td>'+d.destination+(d.leaving?' <span class="dim">leaving</span>':'')
      + (learned ? '<span class="tag">adjusted</span>' : '')
      + (learned && d.blockSeconds ? '<div class="dim">this train running '
          + (d.blockSeconds < 0 ? Math.abs(d.blockSeconds)+'s early' : d.blockSeconds+'s late')
          + ' today</div>' : '')
      + '</td>'
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
}, 15000);`

  return page(title, '<div id="root">loading…</div>', {
    subtitle: 'BART',
    headerRight:
      '<span class="pill"><span class="dot"></span>live</span>' +
      '<a class="pill" href="/dash">profiles</a>',
    style: BART_STYLE,
    script,
  })
}
