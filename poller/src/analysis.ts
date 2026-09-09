import type { FastifyInstance, FastifyReply } from 'fastify'
import * as warehouse from './warehouse.js'
import { loadStopTable } from './gtfs.js'
import { DAY_TYPE_NAMES, DayType, BUCKETS_PER_DAY, formatGtfsTime } from './servicedate.js'
import { asRate, SEGMENT_MIN_RUN } from './schedule.js'
import { esc } from './chrome.js'

/**
 * Making the profile falsifiable.
 *
 * `/bart/:station` exists in this codebase because a synthesized train position is an
 * inference, and the only honest way to ship an inference is to make it easy to catch being
 * wrong. A delay profile needs that more, not less: a train drawn in the wrong place is
 * visible from the platform, whereas "this segment loses ninety seconds on Friday
 * afternoons" is a claim nobody can check by looking.
 *
 * So these pages show the sample count behind every number, separate schedule padding from
 * actual recovery, and never colour a cell so confidently that its evidence stops mattering.
 *
 * Open, like `/health` and `/bart/:station`: they read public transit data and nothing else.
 */

// ---------------------------------------------------------------------------
// The distinction the whole page turns on
// ---------------------------------------------------------------------------

export type SegmentCharacter = 'padding' | 'recovery' | 'congestion' | 'reliable' | 'unknown'

/**
 * Whether a segment that gains time is fast or merely generously timetabled.
 *
 * This is the single most misleading thing a naive "where is delay made up" map can show. A
 * segment with a large negative mean looks like recovery, and on the approach to almost
 * every terminal it is nothing of the kind — it is slack the planner built in, and every
 * vehicle eats it whether it is running late or not. A map that cannot tell the two apart
 * says "delay is made up in the last three stops before the terminal", which is true of
 * every route in the world and useful for none of them.
 *
 * The tell is the slope. Padding gives back the same time to everybody, so it shows a large
 * negative mean with a slope near zero. Real recovery is conditional — a late vehicle gets
 * more of it than an early one — so it shows a negative slope.
 */
export function characterise(mean: number, slope: number, n: number): SegmentCharacter {
  if (n < 10) return 'unknown'
  if (slope < -0.15) return 'recovery'
  if (mean < -20) return 'padding'
  if (mean > 20) return 'congestion'
  return 'reliable'
}

export const CHARACTER_LABEL: Record<SegmentCharacter, string> = {
  padding: 'scheduled slack',
  recovery: 'recovers delay',
  congestion: 'loses time',
  reliable: 'runs to schedule',
  // Not "not enough data": a segment can have enough evidence to move a prediction
  // (PREDICTION_MIN_SAMPLES, 3) while having too little to be called padding rather than
  // recovery (10). Both are true at n=4, and the old wording made the row contradict its
  // own purple marker.
  unknown: 'unclassified',
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Colour for a mean increment, in seconds.
 *
 * Diverging, centred on zero, and — the important part — desaturated by how little evidence
 * is behind it. A confident-looking colour with four observations is exactly the sort of
 * thing people screenshot.
 */
/**
 * Colour for the same value drawn on a map.
 *
 * `colourFor` is tuned for a table cell, where the colour sits behind text on a known
 * background and a faint wash still reads. On a map it does not: at low evidence the alpha
 * falls to about 0.1 and the line disappears into the basemap entirely, which is worse than
 * useless -- a segment that is drawn but invisible looks like a segment with no data.
 *
 * So evidence still fades the colour, but from 1.0 down to 0.55 rather than to nothing, and
 * the lightness is raised for a dark basemap. Confidence is carried by the sample count on
 * the table and in the selection line; on the map it only has to be legible.
 */
export function mapColourFor(mean: number, n: number): string {
  const strength = Math.min(1, Math.abs(mean) / 90)
  const evidence = Math.min(1, n / 30)
  const alpha = 0.55 + 0.45 * evidence
  const light = 52 + 12 * strength
  const hue = mean > 0 ? 6 : 199
  return `hsla(${hue}, 85%, ${light.toFixed(0)}%, ${alpha.toFixed(2)})`
}

export function colourFor(mean: number, n: number): string {
  const strength = Math.min(1, Math.abs(mean) / 120)
  const evidence = Math.min(1, n / 30)
  const alpha = (0.15 + 0.85 * strength) * (0.25 + 0.75 * evidence)
  const hue = mean > 0 ? 4 : 205
  return `hsla(${hue}, 72%, 46%, ${alpha.toFixed(3)})`
}


function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; --fg:#111; --dim:#666; --line:#0002; --bg:#fff; }
@media (prefers-color-scheme: dark) { :root { --fg:#eee; --dim:#999; --line:#fff2; --bg:#111; } }
body { margin:0; padding:1.5rem; background:var(--bg); color:var(--fg);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
h1 { font-size:1.25rem; margin:0 0 .25rem; }
p.sub { color:var(--dim); margin:0 0 1.25rem; }
.scroll { overflow-x:auto; }
table { border-collapse:collapse; font-variant-numeric:tabular-nums; }
th, td { padding:2px 5px; border:1px solid var(--line); white-space:nowrap; font-size:12px; }
th { font-weight:600; text-align:left; position:sticky; left:0; background:var(--bg); }
thead th { position:static; font-weight:500; color:var(--dim); }
td.v { text-align:right; min-width:2.6rem; }
td.thin { opacity:.45; }
.legend { margin-top:1rem; color:var(--dim); font-size:12px; }
.tag { display:inline-block; padding:0 .35rem; border:1px solid var(--line); border-radius:3px; margin-right:.35rem; }
.empty { color:var(--dim); padding:2rem 0; }
a { color:inherit; }
</style></head><body>${body}</body></html>`
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface Row {
  segmentKey: string
  fromStop: string
  toStop: string
  scheduledRun: number
  mean: number
  slope: number
  n: number
  buckets: Map<number, { mean: number; n: number }>
}

export async function buildRows(
  agency: string,
  routeId: string,
  direction: number,
  dayType: number,
): Promise<Row[]> {
  const cells = await warehouse.routeProfile(agency, routeId, direction, dayType)
  if (cells.length === 0) return []

  const stops = await loadStopTable().catch(() => new Map<string, { name: string }>())
  const byKey = new Map<string, Row>()

  for (const c of cells) {
    // The stored key is `agency|route|dir|from>to`; only the last part identifies the hop.
    const hop = c.segmentKey.split('|').slice(3).join('|')
    const [from, rest] = hop.split('>')
    const to = (rest ?? '').split('#')[0]

    let row = byKey.get(hop)
    if (!row) {
      row = {
        segmentKey: hop,
        fromStop: stops.get(from)?.name ?? from,
        toStop: stops.get(to)?.name ?? to,
        scheduledRun: c.scheduledRun,
        mean: 0,
        slope: 0,
        n: 0,
        buckets: new Map(),
      }
      byKey.set(hop, row)
    }

    if (c.bucket === -1) {
      row.mean = c.mean
      row.slope = c.slope
      row.n = c.n
      row.scheduledRun = c.scheduledRun || row.scheduledRun
    } else {
      row.buckets.set(c.bucket, { mean: c.mean, n: c.n })
    }
  }

  return [...byKey.values()]
}

export async function registerAnalysis(app: FastifyInstance): Promise<void> {
  /**
   * The heatmap. Stops down the side, half hours across, coloured by what the segment does.
   */
  app.get<{
    Params: { agency: string; route: string }
    Querystring: { direction?: string; daytype?: string }
  }>('/analysis/:agency/:route', async (request, reply) => {
    const agency = request.params.agency.toUpperCase()
    const routeId = decodeURIComponent(request.params.route)
    const direction = Number(request.query.direction ?? 0) === 1 ? 1 : 0
    const dayType = Number(request.query.daytype ?? DayType.TueThu)

    const qualified = routeId.includes(':') ? routeId : `${agency}:${routeId}`
    const rows = await buildRows(agency, qualified, direction, dayType)

    if (rows.length === 0) {
      return html(
        reply,
        page(
          `${agency} ${routeId}`,
          `<h1>${esc(agency)} ${esc(routeId)}</h1>
           <p class="sub">${esc(DAY_TYPE_NAMES[dayType] ?? '')}, direction ${direction}</p>
           <p class="empty">No profile yet. This is normal for the first few weeks, and for
           any route quiet enough that a half hour rarely sees more than one vehicle.</p>`,
        ),
      )
    }

    // Only the buckets that anything actually ran in — an empty overnight column is noise.
    const active: number[] = []
    for (let b = 0; b < BUCKETS_PER_DAY; b++) {
      if (rows.some((r) => (r.buckets.get(b)?.n ?? 0) > 0)) active.push(b)
    }

    const head =
      `<tr><th>segment</th><th>sched</th><th>mean</th><th>slope</th><th>n</th><th>character</th>` +
      active.map((b) => `<th>${formatGtfsTime(b * 1800).slice(0, 5)}</th>`).join('') +
      `</tr>`

    const body = rows
      .map((r) => {
        const character = characterise(r.mean, r.slope, r.n)
        const cells = active
          .map((b) => {
            const cell = r.buckets.get(b)
            if (!cell || cell.n <= 0) return `<td class="v"></td>`
            const thin = cell.n < 5 ? ' thin' : ''
            return (
              `<td class="v${thin}" style="background:${colourFor(cell.mean, cell.n)}" ` +
              `title="${Math.round(cell.mean)}s over ${cell.n.toFixed(1)} observations">` +
              `${Math.round(cell.mean)}</td>`
            )
          })
          .join('')
        return (
          `<tr><th>${esc(r.fromStop)} &rarr; ${esc(r.toStop)}</th>` +
          `<td class="v">${r.scheduledRun}s</td>` +
          `<td class="v">${Math.round(r.mean)}s</td>` +
          `<td class="v">${r.slope.toFixed(2)}</td>` +
          `<td class="v">${r.n.toFixed(0)}</td>` +
          `<td>${CHARACTER_LABEL[character]}</td>${cells}</tr>`
        )
      })
      .join('')

    const links = [0, 1]
      .map(
        (d) =>
          `<a href="?direction=${d}&daytype=${dayType}">${d === direction ? '<b>' : ''}direction ${d}${d === direction ? '</b>' : ''}</a>`,
      )
      .join(' &middot; ')
    const dayLinks = DAY_TYPE_NAMES.map(
      (name, i) =>
        `<a href="?direction=${direction}&daytype=${i}">${i === dayType ? `<b>${name}</b>` : name}</a>`,
    ).join(' &middot; ')

    return html(
      reply,
      page(
        `${agency} ${routeId}`,
        `<h1>${esc(agency)} ${esc(routeId)}</h1>
         <p class="sub">${links} &nbsp;|&nbsp; ${dayLinks}</p>
         <div class="scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>
         <p class="legend">
           Seconds gained (blue) or lost (red) on each segment, against its scheduled running
           time. Faint cells have little evidence behind them; hover for the count.
           <br><br>
           <span class="tag">scheduled slack</span> gives time back to every vehicle equally —
           it is padding in the timetable, not recovery, and it is why "delay is made up before
           the terminal" is true of every route and useful for none.
           <span class="tag">recovers delay</span> gives more back to a late vehicle than an
           early one, which is the thing worth knowing.
         </p>`,
      ),
    )
  })

  /** The same numbers as JSON, for anything that wants to do its own arithmetic. */
  app.get<{
    Querystring: { agency?: string; route?: string; direction?: string; daytype?: string }
  }>('/v1/profile/route', async (request, reply) => {
    const { agency, route } = request.query
    if (!agency || !route) {
      return reply.code(400).send({ error: 'agency and route are required' })
    }
    const direction = Number(request.query.direction ?? 0) === 1 ? 1 : 0
    const dayType = Number(request.query.daytype ?? DayType.TueThu)
    const qualified = route.includes(':') ? route : `${agency.toUpperCase()}:${route}`
    const rows = await buildRows(agency.toUpperCase(), qualified, direction, dayType)

    return {
      agency: agency.toUpperCase(),
      route: qualified,
      direction,
      dayType,
      dayTypeName: DAY_TYPE_NAMES[dayType] ?? 'unknown',
      segments: rows.map((r) => ({
        segment: r.segmentKey,
        from: r.fromStop,
        to: r.toStop,
        scheduledRun: r.scheduledRun,
        meanSeconds: Number(r.mean.toFixed(1)),
        // The mean as a fraction of the scheduled time, which is the comparable number
        // between a nine-kilometre hop and a two-hundred-metre one.
        meanRate: Number(asRate(r.mean, Math.max(SEGMENT_MIN_RUN, r.scheduledRun)).toFixed(4)),
        slope: Number(r.slope.toFixed(3)),
        samples: Number(r.n.toFixed(1)),
        character: characterise(r.mean, r.slope, r.n),
        buckets: [...r.buckets.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([bucket, c]) => ({
            bucket,
            time: formatGtfsTime(bucket * 1800).slice(0, 5),
            meanSeconds: Number(c.mean.toFixed(1)),
            samples: Number(c.n.toFixed(1)),
          })),
      })),
    }
  })

  /** How the model is scoring. The number that decides whether any of this is worth serving. */
  app.get('/v1/profile/scores', async () => {
    const scores = await warehouse.recentScores()
    return {
      days: 14,
      scores: scores.map((s) => ({
        ...s,
        improvementPercent:
          s.rawMedian > 0
            ? Number((((s.rawMedian - s.corrMedian) / s.rawMedian) * 100).toFixed(1))
            : null,
      })),
      note:
        'coverage is the fraction of actual times that fell inside the published p10-p90 ' +
        'band. It should be close to 0.8. A band that covers far less than it claims is a ' +
        'worse failure than an inaccurate point estimate, because it is the one that gets ' +
        'believed.',
    }
  })
}

function html(reply: FastifyReply, body: string) {
  return reply.header('content-type', 'text/html; charset=utf-8').send(body)
}
