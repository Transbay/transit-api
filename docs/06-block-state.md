# Same-day state

The profile says what a segment does to a *typical* vehicle at a given hour. It says nothing
about the one that has been beating it by twenty-five seconds a stop since six in the
morning.

That is a real, persistent, same-day effect — a driver who runs hot, a light load, a vehicle
in good order, an operator who takes the lights differently — and it is invisible to any
amount of historical averaging, because it is different every day and belongs to nobody in
particular.

## Residual, not lateness

The tracked quantity is the **residual**: what this vehicle did minus what the profile
expected.

```
r ← (1 − w)·r + w·(Δ_observed − Δ_profile)          w = 0.3
```

Not the raw deviation, and the distinction is the whole design. A bus running a genuinely
slow corridor is late without being slow. Keying on lateness would confuse the two and then
project the corridor's own congestion forward a second time, on top of the profile that
already contains it — a systematic double count on exactly the corridors where the profile
is most confident.

`predict.test.ts` pins this with two cases: a vehicle beating the profile every segment
builds a negative residual, and a vehicle *late* every segment by exactly what the profile
predicted builds none.

## Projected forward, shrunk and capped

```
term = λ · r · segments,     λ = observed / (observed + 4)
```

capped at ±180 seconds in total.

`λ` is the answer to "one segment is not a pattern". After one observation the bias is
weighted a fifth; after eight, two thirds; after thirty, nearly all. The cap is there
because one anomalous segment should not be able to run away with a prediction twenty stops
downstream.

The Huber damping used elsewhere is **not** applied here. A genuinely twelve-minutes-late
vehicle is signal for the block model, not an outlier — what is capped is the projection,
not the observation.

## Which identity carries it

`block_id` is the scheduling artefact a driver stays with across trips, which makes it the
right key in principle. In practice a vehicle is swapped mid-block often enough to matter,
and when the two disagree the **vehicle** is the better predictor: the effect being measured
is a combination of driver, vehicle and the traffic immediately around it, and a paper block
survives none of those.

So: vehicle where published, block otherwise.

## Resets

- **A gap over thirty minutes** is a new run, usually with a relief driver. The previous
  driver's bias does not carry across it. Not a decay — a reset, because carrying a stale
  bias across a relief is worse than starting from nothing.
- **A new service date** starts clean.
- **A different key** starts clean.

## Layovers — the most predictable thing here, and the easiest to get spectacularly wrong

A driver twelve minutes late into a terminal with a fifteen-minute layover leaves the
terminal **on time**. The schedule already contains the recovery; that is what a layover is
for.

A model that propagates delay across the trip boundary is confidently wrong on every single
block, every single day, and always in the same direction.

```
outgoing = max(0, incoming − max(0, scheduled_layover − min_turn))
```

`min_turn` (120 s by default) is the part the schedule cannot absorb — the walk to the other
end of the train, the break the contract guarantees. Below it, lateness passes straight
through.

Early in is simply on time out. Nobody leaves a terminal early to use up an early arrival.

This is also why a segment **never crosses a trip boundary** (`schedule.segmentsOf`). Folding
the layover in as if it were a segment would put a large negative increment on the first
segment of every trip, and every route would appear to make up several minutes at its
origin.

## Bunching — measured, deliberately not used

On frequent service the headway matters more than the timetable. A bus ten minutes late on a
six-minute headway is four minutes *behind* an on-time bus: it picks up nobody, dwells less,
and speeds up. The same ten minutes on an hourly route has no such channel — there is nobody
in front to have taken the passengers.

`bunching()` computes the state (`bunched` / `gapped` / `normal`) and it is reported, not
folded into any served number.

That is a deliberate stopping point. The effect is real and the data to model it is already
observed — every vehicle at every stop, which is exactly what a headway is — but an
unvalidated headway term in a published prediction is precisely the kind of plausible
correction this system exists to refuse. [`11-roadmap.md`](11-roadmap.md) has what it would
take.

It also names a known limitation of `β` in [`04-delay-profiles.md`](04-delay-profiles.md):
recovery and bunching have opposite signs and are currently pooled into one slope. Splitting
them needs the headway term, which is the same piece of work.

## Where it lives

Redis, `live:block:<agency>:<serviceDate>:<key>`, eight-hour TTL — past end of service, so
an owl run does not lose its bias at midnight. Written by the learner as part of folding a
batch; read by the prediction path.

Lost with Redis, which is correct: same-day state is worth exactly one day, and rebuilding
it from the warehouse would be more machinery than the thing is worth.
