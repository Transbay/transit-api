# Evaluation

A correction that makes things worse is worse than no correction, and it will not announce
itself. This document is about how we would find out.

## The firewall

> **The learner reads the raw upstream feed. Never this service's own output.**

If a corrected prediction ever became a training input, the model would drift into agreeing
with itself. The symptom is a model that scores beautifully and predicts badly — accuracy
against its own past opinions rather than against the world — and it is among the hardest
kinds of wrong to notice, because every dashboard improves.

Enforced structurally: `rtdecode.ts` and `gtfsrt.ts` are separate modules with no imports
between them, and `learner.ts` imports neither `predictions.ts` nor `snapshot.ts`. A
refactor that breaks this has to delete a file boundary to do it.

It also constrains what may be added later. Anything that feeds a served number back into an
observation — a "smoothed" departure, an imputed time, a corrected value written into the
snapshot — reopens the loop.

## What is scored

Every prediction, whether anybody read it or not. In shadow mode nothing reaches a consumer
and the scoring is the entire point: a model nobody can compare against raw is a model
nobody can ever promote.

Per agency, horizon bucket, hour and route:

| Metric | Why |
|---|---|
| **Median absolute error**, raw vs corrected | The headline. Median rather than mean, because delay is right-skewed and a handful of incidents would otherwise decide the answer |
| **MAE**, both | Kept for comparability with published work |
| **Bias** (mean signed error) | Catches a model that is systematically early or late — invisible in any absolute measure |
| **Coverage** | The fraction of actuals falling inside the published p10–p90 band. Should be ~0.8 |
| **Win rate** | Fraction of predictions where corrected beat raw. A model can win on average while losing most of the time |

### Coverage is the one people skip

It is also the most important. An inaccurate point estimate is a bad prediction. **A band
that covers 55% while claiming 80% is a bad prediction that gets believed**, and it silently
corrupts everything downstream, because inverse-variance fusion weights on exactly the
variances that coverage is testing. If the 90% interval covers 70%, every fusion weight in
the system is wrong and the point estimates are wrong too.

Coverage is checked nightly. Persistent under-coverage means the variance inflation in
`predict.ts` is too small — most likely `SEGMENT_CORRELATION`, which is a prior, not a
measurement.

## The baselines, in order

A model has to beat all three before it is worth anything:

1. **The schedule alone.** Trivially beaten wherever there is realtime.
2. **The agency's raw prediction.** The real bar.
3. **The agency's raw prediction plus a single constant per-agency bias.**

The third is the one that hurts, and it is the one usually left out. If a whole segment
profile does not beat "add eleven seconds to everything SamTrans says", the profile is an
expensive constant. It is entirely plausible that this is where Caltrain and BART land —
both run on rails to a tight timetable with few branches — and finding that out is a
successful outcome, not a failure.

## The promotion gate

Per agency **and per horizon bucket**, because they behave differently: the model should win
at ten and thirty minutes, where a histogram beats a guess, and may well lose at two
minutes, where the agency has a vehicle two hundred metres away and we have history.

Corrected is claimed only when, over the trailing fortnight:

- median absolute error is **≥10% better** than raw, and
- there are **≥2,000 observations** in the context, and
- they span **≥7 days**, and
- coverage is within **[0.75, 0.85]**.

Failing any of these, `/v1/predictions` reports `confidence: "low"` and returns
`predicted == raw`. Regression past the bounds reverts automatically and `/health` says so.

The 2,000 is a *row* count and should be read against the design effect from
[`04-delay-profiles.md`](04-delay-profiles.md): with DEFF ≈ 2.5 the honest sample is
around 800. That is deliberately conservative and deliberately stated.

The gate lives in the database rather than in configuration, so an agency can be disabled
without a deploy.

## Cold start

Three weeks, and the interface should say so rather than looking broken.

- `/v1/predictions` returns `cold: true` while an agency has no profile.
- The analysis pages say "no profile yet. This is normal for the first few weeks."
- `/health` carries profile coverage: the fraction of segments at `n_eff ≥ 10`.

BART will take considerably longer than three weeks. It publishes no vehicle positions
anywhere, so every BART observation is the weakest tier and counts for a fraction of a direct
sighting; its value here is the block and layover models rather than the segment profile.

## What would have to be true to change `/v1/departures`

Recorded because the question will be asked, and because the answer should not be improvised
at the time.

1. **A sustained win at every horizon bucket**, not on average. A model that helps at thirty
   minutes and hurts at two is a model that should be served at thirty minutes and not at
   two — and `/v1/departures` has no way to express that.
2. **Coverage inside the band for a month**, not a fortnight.
3. **The `Expected*` / `Aimed*` decision made deliberately.** The client reads
   live-versus-scheduled straight off which field a time arrives in. A model-adjusted time
   in `Expected*` is a claim that it is a live sighting; in `Aimed*` the app greys it out and
   most boards go empty. Neither is obviously right and the choice must not be a side effect.
4. **The iOS contract fixtures re-captured, not edited.** `RegionalFeedContractTests.swift`
   says this in its own header; it holds here too.
5. **A way back.** A configuration change, not a deploy.

Until all five, the corrected number lives on its own endpoint, where a reader who wants it
asks for it.

## Reading the scores

`GET /v1/profile/scores` returns the trailing fortnight with an `improvementPercent` per
agency and horizon. What to look for:

- **Improvement large and coverage far from 0.8** — the point estimate improved and the
  uncertainty is a lie. Not promotable.
- **Improvement small and win rate below 0.5** — winning on average by winning big
  occasionally and losing slightly most of the time. Often not what a rider wants.
- **Bias drifting steadily** — the agency changed something. Producers retrain and
  redeploy without telling anyone, and a step change in the daily mean residual is what that
  looks like from here. Worth a CUSUM alarm; a sustained shift over 20 s across three days is
  the threshold to start with.
- **Improvement collapsing on one agency only** — usually a service change the schedule
  build has not caught up with. Check the unmatched-trip rate before the model.
