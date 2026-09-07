import type { FastifyInstance } from 'fastify'
import * as warehouse from './warehouse.js'
import { buildRows, colourFor, characterise, CHARACTER_LABEL } from './analysis.js'
import { page, esc, jsonLiteral } from './chrome.js'
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
  sched: number
  mean: number
  slope: number
  n: number
  character: string
  characterLabel: string
  colour: string
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

    const active: number[] = []
    for (let b = 0; b < BUCKETS_PER_DAY; b++) {
      if (rows.some((r) => (r.buckets.get(b)?.n ?? 0) > 0)) active.push(b)
    }

    const segments: SegmentPayload[] = rows.map((r) => {
      const ch = characterise(r.mean, r.slope, r.n)
      return {
        from: r.fromStop,
        to: r.toStop,
        sched: Math.round(r.scheduledRun),
        mean: Math.round(r.mean),
        slope: r.slope,
        n: r.n,
        character: ch,
        characterLabel: CHARACTER_LABEL[ch],
        colour: colourFor(r.mean, r.n),
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
      dayTypeName: DAY_TYPE_NAMES[dayType] ?? String(dayType),
      buckets: active.map((b) => ({ b, label: formatGtfsTime(b * 1800).slice(0, 5) })),
      segments,
      totalObservations: segments.reduce((s, x) => s + x.n, 0),
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
.stack { display:grid; gap:1rem; }
.controls { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; }
.controls label { color:var(--ink-faint); font-size:.72rem; text-transform:uppercase;
                  letter-spacing:.09em; font-weight:600; margin-right:-.25rem; }
.tiers { display:flex; height:9px; border-radius:999px; overflow:hidden;
         border:1px solid var(--edge); margin-top:.5rem; }
.tiers i { display:block; height:100%; }
.tierkey { display:flex; flex-wrap:wrap; gap:.75rem; margin-top:.55rem;
           color:var(--ink-faint); font-size:.72rem; }
.tierkey b { color:var(--ink-dim); font-weight:600; }
.sw { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:.3rem; }
th.stop { position:sticky; left:0; z-index:3; background:var(--panel-bg);
          max-width:340px; overflow:hidden; text-overflow:ellipsis; }
thead th.stop { z-index:4; }
td.v { text-align:right; min-width:2.9rem; font-size:11.5px; }
td.sum { text-align:right; font-variant-numeric:tabular-nums; }
.chip { font-size:10.5px; padding:1px 6px; border-radius:999px; border:1px solid var(--edge);
        color:var(--ink-dim); }
.chip.recovery { color:#4ADE80; border-color:#4ADE8055; }
.chip.padding { color:var(--accent-soft); border-color:#7DD3FC55; }
.chip.congestion { color:#F87171; border-color:#F8717155; }
.chip.unknown { color:var(--ink-faint); }
`

function renderDash(): string {
  const body = `
<div class="stack">

  <section class="panel">
    <h2>System</h2>
    <div class="cols" id="stats"><p class="muted">loading…</p></div>
    <div class="tiers" id="tiers"></div>
    <div class="tierkey" id="tierkey"></div>
  </section>

  <section class="panel">
    <h2>Delay profile</h2>
    <div class="controls">
      <label for="agency">Agency</label><select id="agency"></select>
      <label for="route">Route</label><select id="route"></select>
      <label for="direction">Direction</label><select id="direction"></select>
      <label for="daytype">Day</label><select id="daytype"></select>
      <span class="pill" id="obs">—</span>
    </div>
    <p class="sub" id="hint"></p>
  </section>

  <div id="heat"></div>

  <p class="foot">
    Every number carries the sample count behind it, and colour is desaturated by how little
    evidence there is — a strong colour with n=2 would be the easiest lie this page could tell.
    <b>Scheduled slack is not recovery:</b> padding gives the same seconds back to everyone and
    shows a flat slope, whereas real recovery is conditional on being late and shows a negative
    one. The chips say which.
    <br>Day types are service days, not calendar days: an after-midnight trip belongs to the
    previous day, so owl service appears under the day before, in buckets past 24:00.
  </p>
</div>`

  const script = `
const DT_FALLBACK = ${jsonLiteral(DAY_TYPE_NAMES)};
const $ = (id) => document.getElementById(id);
let ROUTES = [], DTNAMES = DT_FALLBACK;

function fmt(n) { return n === null || n === undefined ? '—' : n.toLocaleString(); }
function stat(k, v, note, cls) {
  return '<div class="stat"><div class="k">' + k + '</div><div class="v ' + (cls||'') + '">' +
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
    '<span class="faint">A tiers are the vehicle reporting itself; Cu is a prediction that left the feed.</span>';
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
  tSel.innerHTML = types.map(t => opt(t, DTNAMES[t] || ('type ' + t), tKeep)).join('');

  $('hint').textContent = types.length
    ? 'Only day types with data are listed.'
    : 'No cells for this route yet.';
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
    return '<div class="panel"><p class="empty">No profile for this combination yet.</p></div>';
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

async function loadRoute() {
  const q = new URLSearchParams({
    agency: $('agency').value, route: $('route').value,
    direction: $('direction').value || '0', daytype: $('daytype').value || '0',
  });
  $('heat').innerHTML = '<div class="panel"><p class="empty">loading…</p></div>';
  try {
    const d = await (await fetch('/dash/api/route?' + q, {cache:'no-store'})).json();
    $('obs').textContent = d.totalObservations.toLocaleString() + ' observations · ' +
      d.segments.length + ' segments';
    $('heat').innerHTML = heatTable(d);
  } catch (e) {
    $('heat').innerHTML = '<div class="panel"><p class="empty">could not load this route</p></div>';
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
    subtitle:
      'What every segment does to a vehicle, learned from the regional feed. ' +
      'Shadow mode — nothing here is served to the app.',
    headerRight:
      '<span class="pill"><span class="dot"></span>live</span>' +
      '<a class="pill" href="/health">/health</a>',
    style: STYLE,
    script,
    wide: true,
  })
}
