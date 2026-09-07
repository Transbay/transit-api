# The delay profile

What the model actually is. Everything here is implemented in `stats.ts` (pure arithmetic)
and `profile.ts` (the ladder and the packed form), both of which are unit-tested against
worked examples.

## 1. Increments, not lateness

For stop *i* on a trip, the deviation is `d_i = actual_i − scheduled_i` — seconds late,
negative for early. The quantity the model is built on is not that. It is the **increment**:

```
Δ_i = d_i − d_{i−1}
```

the time gained or lost on the segment from stop *i−1* to stop *i*.

Three reasons, and the third is the one that matters most:

1. **It is additive.** A prediction for stop 20 is a sum of segment terms, which makes the
   model compositional instead of requiring a separate estimate per (origin, destination).
2. **It is local.** The same physical corridor behaves the same way whoever runs it, so a
   thin route can borrow a busy one's evidence on a segment they share.
3. **It is the answer to the question.** Lateness is mostly *inherited* — a jam at stop 4 is
   still visible at stop 34 — so a model of lateness relearns the same jam thirty times and
   can never say where it happened. "Where is delay made up" is a question about increments
   and cannot be asked of anything else.

### One unit, never mixed

Everything is **departure-to-departure**. Where a producer publishes only one time per
stop, that time is treated as the departure.

This is not arbitrary. Folding departure-to-departure increments together with
departure-to-arrival ones into the same cell biases it by exactly the mean dwell — ten to
thirty seconds — and, worse, the mixture ratio changes silently the day an operator swaps
feed vendors. Where both times are available the arrival is kept as a *separate secondary
series*, never as extra samples in the same cell.

## 2. Cells, and why none of them can speak for itself

The natural key is `(agency, route, direction, from-stop, to-stop, day type, half hour)`.

Across five agencies that is on the order of 25,000 segments; six day types and sixty
buckets each makes **nine million cells**. A busy Muni segment collects maybe eighteen
observations a week into any one of them. Most cells will never have enough data to say
anything.

So no cell speaks for itself. Every estimate is a blend of the cell and its parent, and of
that parent and *its* parent, up to an agency-wide fallback that always has data:

```
θ_L = (n_L · x̄_L + k_L · θ_parent) / (n_L + k_L)
```

At `n = 0` this is the parent exactly. At `n ≫ k` it is the cell's own mean. In between it
is the weighted thing, and `k` is literally "how many observations it takes for this cell to
outvote its parent".

### The ladder

```
0  segment x day type x half hour     the one everybody wants, and almost nobody has
1  segment x day type                 where the tail shape lives
2  segment                            this segment's baseline
3  corridor (same stop pair, any route) x day type
4  route x direction x day type x half hour     held as a rate
5  route x direction                            held as a rate
6  agency x day type x 3 hours                  held as a rate, always populated
```

Walked coarse to fine, because that is the direction the information flows: each rung is the
prior for the next, and the finest rung with evidence ends up dominating exactly to the
extent it has earned it.

### The upper rungs are rates, not seconds

Thirty seconds means something different on a nine-kilometre Transbay hop than on a
two-hundred-metre downtown one. A route-wide average *in seconds* is therefore really an
average of whichever segments happen to be longest, and applying it to a short segment is
nonsense.

Above the segment rungs the quantity stored is `Δ / max(scheduled_run, 20 s)` — a ratio.
"Vehicles on this route at this hour run 8% over their scheduled running time" is a
statement that transfers to a segment the model has never seen, which is the only thing a
fallback is for. Converting back is a multiplication by the target segment's own scheduled
time.

The twenty-second floor is not defensive: Muni's static feed carries plenty of consecutive
stops with identical scheduled times, because the timetable is published to the minute and
two stops two hundred metres apart round to the same one. Dividing by that zero is how a
rate produces infinity.

### Day types: six, not seven

`Mon`, `Tue–Thu`, `Fri`, `Sat`, `Sun`, `Holiday`.

Tuesday, Wednesday and Thursday are the same day as far as traffic is concerned — the
variance *between* them is a handful of seconds, far below the variance *within* any one of
them — so keeping them apart divides the evidence by three and buys nothing. Monday and
Friday genuinely differ: Monday mornings are lighter, Friday afternoons start early and run
heavy. That is why the split is where it is rather than being seven or being three.

Holidays are detected without a hand-maintained list of dates, which would be wrong every
year and would miss the local ones that matter most here. A holiday changes which
`service_id`s run, and comparing today's active set against the same weekday's recent sets
finds it directly.

### Half hours, smoothed

Hard bucket edges produce a visible discontinuity: an estimate that jumps forty seconds as
the clock ticks past `:30`, for no reason anybody could be told. Traffic does not work like
that.

A triangular kernel over three buckets (`0.5, 1, 0.5`) removes the edge and roughly triples
the evidence behind each estimate, for one loop. The centre bucket keeps its own regression
— blending slopes across time of day would mix a peak-hour response with an off-peak one.

## 3. Where `k` comes from

Not from taste. `k = σ²_within / τ²_between`: how noisy one cell is, over how much the cells
genuinely differ from each other, estimated by method of moments over a parent's children.

```
τ̂² = between-cell variance of the child means − σ̂²_within · mean(1/n_j)
k   = σ̂²_within / τ̂²
```

The subtraction is the point: the observed spread of the child means already contains the
sampling noise in each of them, so it has to come off before what is left can be called a
real difference.

This produces a large `k` when the children are indistinguishable (never trust a child that
says nothing new) and a small one when they genuinely differ (trust a child quickly). Both
are correct, and both are wrong if `k` is a constant. `DEFAULT_K` in `profile.ts` holds the
starting values used before there is enough to estimate from.

## 4. The design effect — the correction that changes every threshold

**Consecutive trips on a route are not independent observations.** Two buses ten minutes
apart share the same signal timing, the same crash, the same rain. Counting them as
independent inflates every sample size in the system.

```
n_eff = n / DEFF        DEFF = 1 + (m̄ − 1)·ρ
```

With about four observations a day into a cell and a within-day correlation around 0.5,
**DEFF is 2.5** — so the honest sample size is well under half the row count.

This is not a refinement. It flows into everything: shrinkage under-shrinks without it,
every confidence interval is too narrow, the "is this cell trustworthy" threshold fires far
too early, and the promotion gate in `07-evaluation.md` passes on a fifth of the evidence it
thinks it has. `ρ` should be measured per agency (variance of daily cell means against
pooled variance); `PROFILE_ICC` holds the prior.

## 5. Decay, and why a service change is not a decay problem

Every count is exponentially decayed with a **21-day half-life**, applied lazily on read
from a stored timestamp. Transit changes; a signal retimed in March should stop arguing
about June without anybody having to remember to delete anything.

Worked, so the expectations are explicit — stationary effective count is about
`30.7 × observations per day`:

| Cell | Observations/week | n (raw) | n after DEFF |
|---|---|---|---|
| 10-minute Muni segment, Tue–Thu, one half hour | 18 | ~79 | **~32** |
| Hourly SamTrans route, same cell | 3 | ~13 | **~5** |
| Sunday 60-minute route | 1 | ~4.4 | **~1.8** |

The bottom two rows *are* their parent, permanently. The interface says so rather than
implying otherwise: sample counts travel with every estimate, on the API and on the pages.

**A timetable change is a different problem and gets a different answer.** Decay would take
three weeks to forget a schedule that changed on Saturday — but the observations are not
wrong, what they were measured *against* changed. So a cell is **re-based**: if the schedule
gives a segment thirty more seconds, every past deviation shifts by thirty seconds and the
corridor's actual behaviour is unchanged. The evidence survives, discounted once. Storing
`scheduled_run` on the cell is what makes this possible, and is why it is there.

## 6. Timepoint censoring — the thing that would silently poison everything

Muni, SamTrans and Golden Gate hold early vehicles at timepoints. The bus arrives four
minutes early, waits, and leaves on the minute.

So at a timepoint the departure deviation is **censored**: it is `max(arrival deviation +
dwell, hold)` regardless of how early the vehicle actually was. A model that averages
departures there learns "this segment reliably absorbs four minutes of earliness".

It does not. It has a clock.

The consequence downstream is worse than a wrong average: the model then predicts recovery
at a stop where none happens, and a rider is told the bus is at the platform when it left
four minutes ago.

`deviation.ts` handles it explicitly:

- A held stop contributes its **arrival** deviation to the running-time model, which is
  uncensored, and its departure to the holding model.
- Where only one time is published, the observation is marked `held-composite` and excluded
  from the running-time model rather than guessed at.
- Predicting forward, the censoring is applied in the same direction:
  `departure = max(predicted, scheduled + hold_offset)`.

`hold_offset` is not zero. Drivers open the doors, wait out the clock and pull away a few
seconds after the published minute; measured across operators this sits in the +5 to +25
second range, and assuming exactly zero makes every timepoint look very slightly late.

`timepoint = 1` is also not trusted on its own — plenty of producers set it everywhere or
nowhere. A stop is treated as holding only if the flag is set *and* the observed
distribution has almost no mass below −60 s.

## 7. The conditional response, and the trap in estimating it

Each segment rung also carries a streaming regression:

```
E[Δ_i | d_{i−1}] = α + β · d_{i−1}
```

`β` is the interesting parameter. Negative is a **recovery** segment — schedule slack a late
vehicle eats into. Positive is **amplification** — a late bus meets a bigger crowd at every
stop and falls further behind.

It does two jobs. It turns "delay is made up somewhere along here" from an anecdote into a
number. And it stops the forward projection being a random walk: summing average increments
over twenty stops compounds them without bound, while

```
d_k = (1 + β)·d_{k−1} + α
```

with `β ∈ (−1, 0)` is a stable AR(1) that settles toward an equilibrium, which is what
schedule slack actually does.

**The trap.** `d_{i−1}` is a *measured* quantity, so it carries observation error, and a
regression with a noisy predictor is biased toward zero slope — errors-in-variables. Worse,
`Δ_i = d_i − d_{i−1}` contains minus the same error, so the bias is guaranteed negative:

```
plim β̂ ≈ β − (1 + β)·σ²_u / (σ²_d + σ²_u)
```

With direct observations (σ_u ≈ 20 s against σ_d ≈ 120 s) the bias is about 0.03 —
tolerable. With observations inferred from converged predictions (σ_u ≈ 60–90 s) it is
around **0.20**, which would "discover" twenty points of spurious delay absorption on
exactly the segments whose observations are worst: low-frequency routes and BART.

Two defences, both in the code:

1. **Only the two direct tiers feed the regression.** `learner.ts` passes `priorDev` only
   for tier A1 and A2; inferred observations still train the mean but never the slope.
2. **The fitted slope is shrunk toward zero by its own evidence** (`fit(r, kSlope)`), so a
   thin cell cannot assert a large effect, and clamped to `[−0.9, 0.6]` so the propagation
   cannot diverge.

**A known limitation, recorded rather than papered over.** `β` currently conflates two
mechanisms with opposite signs. Slack recovery is a function of lateness; bunching is a
function of *headway* deviation. A bus ten minutes late on a six-minute headway is four
minutes behind an on-time bus, picks up nobody and speeds up; the same ten minutes on an
hourly route has no such channel. Pooling frequent and infrequent routes into one `β` mixes
them. Splitting the term is in [`11-roadmap.md`](11-roadmap.md), and the headway data needed
for it is already observed.

## 8. Spread, and why the mean is not the number to act on

Delay is strongly right-skewed: buses are occasionally very late and never very early. A
mean and a standard deviation cannot produce an honest band from that.

So each `(segment, day type)` cell keeps a **histogram** — 92 variable-width bins, fine
(15 s) between −5 and +10 minutes and coarse (60 s) in the tails, about 370 bytes. Histograms
merge by addition, which is exactly what walking the ladder needs, and they give quantiles
directly.

Only at the day-type rung. Tail *shape* is a property of a segment and a day type — the long
tail of a PM-peak corridor looks the same at 17:15 as at 17:45 — and storing one per half
hour would be a gigabyte of the same curve written sixty times. A leaf's band is the
parent's shape shifted to the leaf's own centre.

### Deconvolution

An increment is a difference of two observed times, so it carries *both* of their errors.
On a 400 m Muni hop the true increment might vary by ten seconds while each endpoint is
measured to ±15 s — so the observed spread is mostly instrumentation, and the "where delay
is made up" heatmap would render a ±15 s checkerboard of pure noise.

`deconvolve(observed, noise)` subtracts the known measurement variance before the spread is
reported. The stored `noise_var` per cell is the mean measurement variance of the
observations behind it, which is why every observation carries its σ.

## 9. What the hot path actually reads

Not this. The full cells live in Postgres; what the prediction path reads is a packed
binary blob per `(agency, route, direction, day type)` in Redis, holding per segment: the
scheduled running time, the fitted slope, the all-time mean, sd and count, and then per
half-hour bucket a mean, an sd and a count in four bytes.

About 300 bytes per segment, ~15 KB for a fifty-segment route, and on the order of 50 MB for
everything.

The obvious alternative — one Redis hash field per cell — costs roughly 110 bytes of Redis
overhead *per field*, which across a few million populated cells is most of a gigabyte of
key metadata to store a few tens of megabytes of numbers. It is also forty round trips to
predict one trip where this is one. `02-data-model.md` has the layout.
