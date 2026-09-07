import type { FastifyInstance } from 'fastify'
import * as warehouse from './warehouse.js'
import { buildRows, colourFor, mapColourFor, characterise, CHARACTER_LABEL } from './analysis.js'
import { page, esc, jsonLiteral } from './chrome.js'
import { loadStopTable } from './gtfs.js'
import { mapkitConfigured } from './mapkit.js'
import { DAY_TYPE_NAMES, BUCKETS_PER_DAY, formatGtfsTime } from './servicedate.js'

/**
 * The dashboard.
 *
 * `/analysis/:agency/:route` answers one question if you already know which route and which
 * day type to ask about. In practice nobody does -- the day type alone is a trap, because an
 * owl trip belongs to the previous service day and a holiday is its own class, so the two
 * most obvious URLs are empty for reasons that have nothing to do with the data being there.
 *
 * So this page discovers what exists and offers it, rather than making you guess a URL. It
 * lists only the (route, direction, day type) combinations that actually have cells behind
 * them, which means an empty picker is a true statement about the warehouse rather than a
 * wrong guess about a parameter.
 *
 * Colours come from the server, not from a copy of `colourFor` written in client JavaScript.
 * That function encodes a judgement -- desaturate by how little evidence there is -- and a
 * second implementation of it would drift from the first without anybody noticing, which is
 * exactly the failure this whole codebase is built to avoid.
 */

interface BucketCell {
  b: number
  mean: number
  n: number
  c: string
}

interface SegmentPayload {
  from: string
  to: string
  /** Endpoint coordinates, absent when the static feed has no position for a stop. */
  fromLat?: number
  fromLon?: number
  toLat?: number
  toLon?: number
  sched: number
  mean: number
  slope: number
  n: number
  character: string
  characterLabel: string
  colour: string
  /** Higher-contrast variant, for the line on the map. */
  mapColour: string
  buckets: BucketCell[]
}

export async function registerDash(app: FastifyInstance): Promise<void> {
  /** Which (agency, route, direction, day type) combinations actually have cells. */
  app.get('/dash/api/routes', async () => {
    const rows = await warehouse.profiledRoutes()
    const byRoute = new Map<
      string,
      { agency: string; routeId: string; label: string; combos: { d: number; t: number }[] }
    >()
    for (const r of rows) {
      const key = `${r.agency}|${r.routeId}`
      let entry = byRoute.get(key)
      if (!entry) {
        entry = {
          agency: r.agency,
          routeId: r.routeId,
          // `SF:14` reads as `14` to anybody who already knows they picked Muni.
          label: r.routeId.includes(':') ? r.routeId.split(':').slice(1).join(':') : r.routeId,
          combos: [],
        }
        byRoute.set(key, entry)
      }
      entry.combos.push({ d: r.directionId, t: r.dayType })
    }
    const routes = [...byRoute.values()].sort(
      (a, b) =>
        a.agency.localeCompare(b.agency) ||
        a.label.localeCompare(b.label, undefined, { numeric: true }),
    )
    return { routes, dayTypeNames: DAY_TYPE_NAMES }
  })

  /** One route's heatmap, already coloured. */
  app.get<{
    Querystring: { agency?: string; route?: string; direction?: string; daytype?: string }
  }>('/dash/api/route', async (request, reply) => {
    const agency = (request.query.agency ?? '').toUpperCase()
    const routeId = request.query.route ?? ''
    if (!agency || !routeId) return reply.code(400).send({ error: 'agency and route required' })

    const direction = Number(request.query.direction ?? 0) === 1 ? 1 : 0
    const dayType = Number(request.query.daytype ?? 0)
    const qualified = routeId.includes(':') ? routeId : `${agency}:${routeId}`

    const rows = await buildRows(agency, qualified, direction, dayType)

    // The hop's stop ids survive on segmentKey even though buildRows resolves the display
    // names, which is what lets the map draw a line the table can only describe.
    const stops = await loadStopTable().catch(() => new Map())
    const coordsFor = (segmentKey: string) => {
      const [from, rest] = segmentKey.split('>')
      const to = (rest ?? '').split('#')[0]
      const a = stops.get(from)
      const b = stops.get(to)
      return {
        fromLat: a?.lat,
        fromLon: a?.lon,
        toLat: b?.lat,
        toLon: b?.lon,
      }
    }

    const active: number[] = []
    for (let b = 0; b < BUCKETS_PER_DAY; b++) {
      if (rows.some((r) => (r.buckets.get(b)?.n ?? 0) > 0)) active.push(b)
    }

    const segments: SegmentPayload[] = rows.map((r) => {
      const ch = characterise(r.mean, r.slope, r.n)
      return {
        ...coordsFor(r.segmentKey),
        from: r.fromStop,
        to: r.toStop,
        sched: Math.round(r.scheduledRun),
        mean: Math.round(r.mean),
        slope: r.slope,
        n: r.n,
        character: ch,
        characterLabel: CHARACTER_LABEL[ch],
        colour: colourFor(r.mean, r.n),
        mapColour: mapColourFor(r.mean, r.n),
        buckets: active.map((b) => {
          const cell = r.buckets.get(b)
          return {
            b,
            mean: cell ? Math.round(cell.mean) : 0,
            n: cell?.n ?? 0,
            c: cell && cell.n > 0 ? colourFor(cell.mean, cell.n) : 'transparent',
          }
        }),
      }
    })

    return {
      agency,
      routeId: qualified,
      direction,
      dayType,
      dayTypeName: dayType < 0 ? 'All days' : (DAY_TYPE_NAMES[dayType] ?? String(dayType)),
      buckets: active.map((b) => ({ b, label: formatGtfsTime(b * 1800).slice(0, 5) })),
      segments,
      totalObservations: segments.reduce((s, x) => s + x.n, 0),
      mapsEnabled: mapkitConfigured(),
    }
  })

  app.get('/dash', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8')
    return renderDash()
  })
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const STYLE = `
.controls { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; }
.controls label { color:var(--ink-faint); font-size:.72rem; text-transform:uppercase;
                  letter-spacing:.09em; font-weight:600; margin-right:-.25rem; }
.tiers { display:flex; height:8px; border-radius:999px; overflow:hidden;
         border:1px solid var(--edge); margin-top:1rem; }
.tiers i { display:block; height:100%; }
.tierkey { display:flex; flex-wrap:wrap; gap:.75rem; margin-top:.55rem;
           color:var(--ink-faint); font-size:.72rem; }
.tierkey b { color:var(--ink-dim); font-weight:600; }
.sw { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:.3rem; }
th.stop { position:sticky; left:0; z-index:3; background:var(--panel-bg);
          max-width:340px; overflow:hidden; text-overflow:ellipsis; }
thead th.stop { z-index:4; }
td.v { text-align:right; min-width:2.9rem; font-size:11.5px; }
td.sum { text-align:right; }
.chip.recovery { color:#4ADE80; border-color:#4ADE8055; }
.chip.padding { color:var(--accent-soft); border-color:#7DD3FC55; }
.chip.congestion { color:#F87171; border-color:#F8717155; }
#map { height:460px; border-radius:12px; overflow:hidden; background:#0f1115; }
.mapsel { color:var(--ink-dim); font-size:.82rem; margin-top:.75rem; min-height:1.2em; }
.mapsel b { color:var(--ink); font-weight:600; }
`

function renderDash(): string {
  const body = `
<div class="stack">

  <section class="glass glass-pad">
    <h2>System</h2>
    <div class="figs" id="stats"><p class="muted">Loading…</p></div>
    <div class="tiers" id="tiers"></div>
    <div class="tierkey" id="tierkey"></div>
  </section>

  <section class="glass glass-pad">
    <h2>Delay profile</h2>
    <div class="controls">
      <label for="agency">Agency</label><select id="agency"></select>
      <label for="route">Route</label><select id="route"></select>
      <label for="direction">Direction</label><select id="direction"></select>
      <label for="daytype">Day</label><select id="daytype"></select>
      <span class="chip" id="obs">—</span>
    </div>
    <p class="muted small" id="hint"></p>
  </section>

  <section class="glass glass-pad" id="mapPanel" hidden>
    <h2>Where it happens</h2>
    <div id="map"></div>
    <div class="mapsel" id="mapsel"></div>
  </section>

  <div id="heat"></div>

</div>`

  const script = `
const DT_FALLBACK = ${jsonLiteral(DAY_TYPE_NAMES)};
const $ = (id) => document.getElementById(id);
let ROUTES = [], DTNAMES = DT_FALLBACK;

function fmt(n) { return n === null || n === undefined ? '—' : n.toLocaleString(); }
function stat(k, v, note, cls) {
  return '<div class="fig"><div class="k">' + k + '</div><div class="v ' + (cls||'') + '">' +
         v + '</div>' + (note ? '<div class="n">' + note + '</div>' : '') + '</div>';
}

async function loadStatus() {
  let h;
  try { h = await (await fetch('/health', {cache:'no-store'})).json(); }
  catch (e) { $('stats').innerHTML = '<p class="muted">/health unreachable</p>'; return; }

  const p = h.profile || {}, lr = p.learner || {}, wh = p.warehouse || {};
  const tr = (p.observation || {}).tracker || {};
  const t = tr.byTier || [0,0,0,0,0,0];
  const tot = t.reduce((a,b) => a+b, 0) || 1;
  const direct = 100 * (t[0] + t[1]) / tot;
  const admitted = lr.observations ? 100 * lr.admitted / lr.observations : 0;
  const ages = (h.poll && h.poll.agencies || []).map(a => a.ageSeconds).filter(x => x !== null);
  const freshest = ages.length ? Math.min.apply(null, ages) : null;
  const budget = (h.budget || []).reduce((a,x) => a + x.used, 0);
  const limit = (h.budget || []).reduce((a,x) => a + x.limit, 0);

  $('stats').innerHTML = [
    stat('Observations', fmt(lr.observations), fmt(tr.events) + ' events seen'),
    stat('Admitted', admitted.toFixed(0) + '%', fmt(lr.admitted) + ' into profiles',
         admitted > 60 ? 'good' : 'warn'),
    stat('Profile cells', fmt(wh.profileCells), fmt(wh.observedDays) + ' service days'),
    stat('Active trips', fmt((p.observation||{}).activeTrips), fmt(tr.cycles) + ' poll cycles'),
    stat('Direct observation', direct.toFixed(0) + '%', 'tiers A1+A2, not predictions'),
    stat('511 budget', budget + '/' + limit, 'this hour'),
    stat('Snapshot age', freshest === null ? '—' : freshest + 's', "511's clock, not ours"),
    stat('Learner', lr.leader ? 'leading' : 'idle',
         'fold ' + (lr.lastTickMs || 0) + 'ms · ' + fmt(lr.ticks) + ' folds',
         lr.leader ? 'good' : 'bad'),
  ].join('');

  const names = ['A1','A2','B','C','Cu','D'];
  const cols = ['#38BDF8','#7DD3FC','#4ADE80','#FBBF24','#6B7280','#F87171'];
  $('tiers').innerHTML = t.map((v,i) =>
    '<i style="width:' + (100*v/tot) + '%;background:' + cols[i] + '"></i>').join('');
  $('tierkey').innerHTML = t.map((v,i) =>
    '<span><span class="sw" style="background:' + cols[i] + '"></span><b>' + names[i] +
    '</b> ' + fmt(v) + '</span>').join('') +
    '';
}

// Negative day types are the ladder's pooled rungs -- every day together -- not a day of
// the week. Left unnamed they render as "type -1", which reads as a bug.
function dayName(t) {
  return t < 0 ? 'All days' : (DTNAMES[t] || ('Type ' + t));
}

function opt(v, label, sel) {
  return '<option value="' + v + '"' + (String(v) === String(sel) ? ' selected' : '') + '>' +
         label + '</option>';
}

function refreshPickers(keepRoute) {
  const agencies = [...new Set(ROUTES.map(r => r.agency))].sort();
  const aSel = $('agency');
  if (!aSel.options.length) aSel.innerHTML = agencies.map(a => opt(a, a)).join('');
  const agency = aSel.value || agencies[0];
  aSel.value = agency;

  const mine = ROUTES.filter(r => r.agency === agency);
  const rSel = $('route');
  const want = keepRoute && mine.some(r => r.routeId === keepRoute) ? keepRoute : null;
  rSel.innerHTML = mine.map(r => opt(r.routeId, r.label, want)).join('');
  if (want) rSel.value = want;

  const route = ROUTES.find(r => r.agency === agency && r.routeId === rSel.value);
  const combos = route ? route.combos : [];

  const dirs = [...new Set(combos.map(c => c.d))].sort();
  const dSel = $('direction');
  const dKeep = dirs.includes(Number(dSel.value)) ? dSel.value : dirs[0];
  dSel.innerHTML = dirs.map(d => opt(d, 'dir ' + d, dKeep)).join('');

  const types = [...new Set(combos.filter(c => c.d === Number(dSel.value)).map(c => c.t))].sort();
  const tSel = $('daytype');
  const tKeep = types.includes(Number(tSel.value)) ? tSel.value : types[0];
  tSel.innerHTML = types.map(t => opt(t, dayName(t), tKeep)).join('');

  $('hint').textContent = types.length ? '' : 'No data for this route yet.';
}

async function loadRoutes() {
  const d = await (await fetch('/dash/api/routes', {cache:'no-store'})).json();
  ROUTES = d.routes || [];
  if (d.dayTypeNames) DTNAMES = d.dayTypeNames;
  if (!ROUTES.length) {
    $('hint').textContent = 'No profiles yet. Cells appear once the learner has folded real observations.';
    return;
  }
  refreshPickers();
  loadRoute();
}

function heatTable(d) {
  if (!d.segments.length) {
    return '<div class="glass glass-pad"><p class="empty">No data for this combination yet.</p></div>';
  }
  const head = '<tr><th class="stop">Segment</th><th>sched</th><th>mean</th><th>slope</th>' +
    '<th>n</th><th>character</th>' +
    d.buckets.map(b => '<th>' + b.label + '</th>').join('') + '</tr>';

  const rows = d.segments.map(s => {
    const cells = s.buckets.map(c =>
      '<td class="v" style="background:' + c.c + '" title="' +
      (c.n ? c.n + ' obs' : 'no data') + '">' +
      (c.n ? (c.mean > 0 ? '+' : '') + c.mean : '') + '</td>').join('');
    return '<tr><th class="stop" title="' + s.from + ' → ' + s.to + '">' +
      s.from + ' → ' + s.to + '</th>' +
      '<td class="sum faint">' + s.sched + 's</td>' +
      '<td class="sum" style="background:' + s.colour + '">' +
        (s.mean > 0 ? '+' : '') + s.mean + 's</td>' +
      '<td class="sum faint">' + s.slope.toFixed(2) + '</td>' +
      '<td class="sum">' + s.n + '</td>' +
      '<td><span class="chip ' + s.character + '">' + s.characterLabel + '</span></td>' +
      cells + '</tr>';
  }).join('');

  return '<div class="scroll"><table><thead>' + head + '</thead><tbody>' + rows +
         '</tbody></table></div>';
}

// --- map -------------------------------------------------------------------
// Loaded lazily and only when a key is configured, so a deploy without one is a page
// without a map rather than a page with a broken one.
let mapkitReady = null, theMap = null, overlays = [];

function loadMapkit() {
  if (mapkitReady) return mapkitReady;
  mapkitReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js';
    s.crossOrigin = 'anonymous';
    s.onerror = () => reject(new Error('mapkit.js failed to load'));
    s.onload = () => {
      try {
        mapkit.init({
          authorizationCallback: (done) => {
            fetch('/v1/mapkit/token', {cache:'no-store'})
              .then(r => r.ok ? r.text() : Promise.reject(new Error('token ' + r.status)))
              .then(done)
              .catch(reject);
          },
        });
        resolve();
      } catch (e) { reject(e); }
    };
    document.head.appendChild(s);
  });
  return mapkitReady;
}

function drawMap(d) {
  const hops = d.segments.filter(s =>
    typeof s.fromLat === 'number' && typeof s.fromLon === 'number' &&
    typeof s.toLat === 'number' && typeof s.toLon === 'number');
  const panel = $('mapPanel');
  if (!d.mapsEnabled || !hops.length) { panel.hidden = true; return; }
  panel.hidden = false;

  loadMapkit().then(() => {
    if (!theMap) {
      theMap = new mapkit.Map('map', {
        colorScheme: mapkit.Map.ColorSchemes.Dark,
        showsCompass: mapkit.FeatureVisibility.Hidden,
        showsScale: mapkit.FeatureVisibility.Adaptive,
      });
    }
    theMap.removeOverlays(overlays);
    // Two passes: every casing first, then every colour. Drawn per-hop instead, one
    // segment's casing lands on top of its neighbour's colour and the line looks dashed.
    const coords = s => [new mapkit.Coordinate(s.fromLat, s.fromLon),
                         new mapkit.Coordinate(s.toLat, s.toLon)];
    const casings = hops.map(s => new mapkit.PolylineOverlay(coords(s), {
      style: new mapkit.Style({ lineWidth: 11, lineCap: 'round',
                                strokeColor: '#05070B', strokeOpacity: 0.85 }) }));
    const lines = hops.map(s => {
      const o = new mapkit.PolylineOverlay(coords(s), {
        style: new mapkit.Style({ lineWidth: 6, lineCap: 'round',
                                  strokeColor: s.mapColour || '#38BDF8' }) });
      o.data = s;
      return o;
    });
    overlays = casings.concat(lines);
    theMap.addOverlays(overlays);

    // Frame the route rather than the region: a fixed span puts half of Muni off-screen.
    const lats = hops.flatMap(s => [s.fromLat, s.toLat]);
    const lons = hops.flatMap(s => [s.fromLon, s.toLon]);
    const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const cLon = (Math.min(...lons) + Math.max(...lons)) / 2;
    theMap.region = new mapkit.CoordinateRegion(
      new mapkit.Coordinate(cLat, cLon),
      new mapkit.CoordinateSpan(
        Math.max(0.01, (Math.max(...lats) - Math.min(...lats)) * 1.3),
        Math.max(0.01, (Math.max(...lons) - Math.min(...lons)) * 1.3)));

    theMap.addEventListener('select', (ev) => {
      const s = ev.overlay && ev.overlay.data;
      if (!s) return;
      $('mapsel').innerHTML = '<b>' + s.from + ' → ' + s.to + '</b> · scheduled ' + s.sched +
        's · mean ' + (s.mean > 0 ? '+' : '') + s.mean + 's · slope ' + s.slope.toFixed(2) +
        ' · n=' + s.n + ' · ' + s.characterLabel;
    });
  }).catch(e => {
    panel.hidden = false;
    $('mapsel').textContent = 'Map unavailable: ' + e.message;
  });
}

async function loadRoute() {
  const q = new URLSearchParams({
    agency: $('agency').value, route: $('route').value,
    direction: $('direction').value || '0', daytype: $('daytype').value || '0',
  });
  $('heat').innerHTML = '<div class="glass glass-pad"><p class="empty">Loading…</p></div>';
  try {
    const d = await (await fetch('/dash/api/route?' + q, {cache:'no-store'})).json();
    $('obs').textContent = d.totalObservations.toLocaleString() + ' observations · ' +
      d.segments.length + ' segments';
    $('heat').innerHTML = heatTable(d);
    drawMap(d);
  } catch (e) {
    $('heat').innerHTML = '<div class="glass glass-pad"><p class="empty">Could not load this route.</p></div>';
  }
}

$('agency').addEventListener('change', () => { refreshPickers(); loadRoute(); });
$('route').addEventListener('change', () => { refreshPickers($('route').value); loadRoute(); });
$('direction').addEventListener('change', () => { refreshPickers($('route').value); loadRoute(); });
$('daytype').addEventListener('change', loadRoute);

loadStatus();
loadRoutes();
setInterval(loadStatus, 15000);
`

  return page('Delay profiles', body, {
    headerRight: '<span class="chip"><span class="dot"></span>Live</span>',
    style: STYLE,
    script,
    wide: true,
  })
}
