import type { FastifyInstance } from 'fastify'
import { page } from './chrome.js'

/**
 * What the corrections are and where they come from.
 *
 * Linked from the purple banner on every board, because a number we changed is worth less
 * than a number we changed and explained.
 */

const STYLE = `
.how h2 { margin-top:0; }
.how p { color:var(--ink-dim); max-width:64ch; }
.how p.tight { margin-bottom:.5rem; }
.how ol { color:var(--ink-dim); max-width:64ch; padding-left:1.1rem; }
.how li { margin-bottom:.5rem; }
.how b { color:var(--ink); font-weight:600; }
.how code { font-family:var(--font-mono); font-size:.85em; background:rgba(255,255,255,.06);
            padding:.1rem .35rem; border-radius:4px; color:var(--ink); }
.how .stack > * + * { margin-top:1rem; }
.eg { font-family:var(--font-mono); font-size:.8rem; color:var(--ink-dim);
      border-left:2px solid #8B6BF0; padding:.15rem 0 .15rem .8rem; margin:.75rem 0; }
.eg b { color:#A78BFA; font-weight:600; }
`

export async function registerHow(app: FastifyInstance): Promise<void> {
  app.get('/how', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8')
    return render()
  })
}

function render(): string {
  const body = `
<div class="stack how">

  <section class="glass glass-pad">
    <h2>The short version</h2>
    <p>
      Transit agencies publish their own arrival predictions. Those predictions are often
      wrong in ways that repeat: the same hop is slow every weekday at 5pm, the same stretch
      of Market Street always gives back a minute, the same bus runs hot all afternoon.
      We record what actually happens, and use it to adjust the countdown.
    </p>
    <p>
      Anything we adjust is boxed in purple and labelled. The agency's own time stays visible
      underneath so you can see both.
    </p>
  </section>

  <section class="glass glass-pad">
    <h2>Where the history comes from</h2>
    <p class="tight">
      We read the regional feed every fifteen seconds. It never says when a vehicle left a
      stop, only when it is expected to, so departures are inferred from vehicle positions
      where operators publish them and from how predictions moved where they do not. Every
      observation is tagged with how it was obtained, and the weaker kinds count for less.
    </p>
    <p>
      Each observation becomes an <b>increment</b>: the seconds gained or lost on one hop
      between two stops, compared with the timetable. Increments are the useful unit because
      they add up along a trip and because they are local, so a jam at one intersection is
      learned once instead of being blamed on all thirty stops after it.
    </p>
  </section>

  <section class="glass glass-pad">
    <h2>The profile</h2>
    <p class="tight">
      Increments are pooled into a cell for every combination of route, direction, stop pair,
      day type and half hour. Most cells are thin, so each one is pulled toward its broader
      parent until it has evidence of its own. A hop with four observations mostly reflects
      what that corridor does in general. A hop with two hundred speaks for itself.
    </p>
    <p>
      We also keep the slope of delay against lateness, which separates two things that look
      identical in an average. A segment that gives every vehicle the same thirty seconds
      back is <b>scheduled slack</b>. A segment that gives a late vehicle more than an early
      one is <b>real recovery</b>. Only the second is worth predicting from.
    </p>
    <div class="eg">
      SF 5 inbound, McAllister &amp; Leavenworth to Market &amp; 5th<br>
      scheduled 144s, <b>actually 234s</b>, across 10 observations
    </div>
  </section>

  <section class="glass glass-pad">
    <h2>Today's vehicle</h2>
    <p class="tight">
      A profile describes a typical vehicle. It says nothing about the one that has been
      beating it by twenty five seconds a stop since six in the morning.
    </p>
    <p class="tight">
      So we track each block through its day, as a running average of the difference between
      what it did and what the profile expected. Measuring against the profile rather than
      against the timetable matters: it separates an aggressive driver from a bus on a road
      that is slow for everyone. Where an operator publishes a block we follow the block,
      which is what carries a driver across trips. Where it does not we follow the vehicle.
    </p>
    <p>
      The effect is capped, and it fades in as the day produces evidence rather than
      arriving at full strength off one stop. It resets on a block change or a long gap,
      because that is usually a new run and often a new operator.
    </p>
  </section>

  <section class="glass glass-pad">
    <h2>Putting it together</h2>
    <ol>
      <li><b>Schedule plus profile.</b> From the last stop we are confident about, walk
        forward adding what each segment usually does, adjusted for how late the vehicle
        already is, plus today's vehicle term.</li>
      <li><b>The agency's prediction, corrected</b> by how wrong that agency's predictions
        usually are at this stop, at this horizon, at this time of day.</li>
      <li><b>Today's pace alone</b>, extrapolated with the profile removed. Weak by itself,
        useful when a route is new to us and the vehicle is behaving consistently.</li>
    </ol>
    <p>
      Each estimate carries its own uncertainty, measured from its own history, and they are
      combined in proportion to it. Nothing is hand weighted. Whichever estimate has been
      reliable in this situation ends up dominating, and that changes by route and by hour
      without anyone tuning it.
    </p>
  </section>

  <section class="glass glass-pad">
    <h2>When we refuse</h2>
    <p class="tight">
      A correction has to survive several checks before it is shown. Stops stay in order.
      A departure never precedes its arrival. Nothing implies a speed the vehicle cannot
      do. Corrections are capped relative to how far out the departure is, so a distant
      prediction cannot be moved dramatically on thin evidence.
    </p>
    <p class="tight">
      A hop needs at least three observations before it influences anything at all. Below
      that the countdown is exactly what the agency said, unmarked. Most stops are in that
      state today, which is why most rows are not purple.
    </p>
    <p>
      Where a stop holds early vehicles until their scheduled time, we model the hold rather
      than averaging through it, because otherwise the timetable looks like recovery and we
      would confidently predict a bus catching up at a stop that merely has a clock.
    </p>
  </section>

  <section class="glass glass-pad">
    <h2>What this does not touch</h2>
    <p>
      The published departures API returns the agency's own times, unchanged. Corrections
      live only on these pages and on a separate endpoint, and they are scored against what
      actually happened before any of them would be promoted. A model that cannot be
      compared with the raw feed is a model nobody should trust.
    </p>
  </section>

</div>`

  return page('How it works', body, { style: STYLE })
}
