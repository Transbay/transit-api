import { writeFile } from 'node:fs/promises'
import { config } from './config.js'
import { redis } from './redis.js'
import { fetchUpstreamProtobuf } from './upstream.js'
import {
  decodeTripUpdates,
  decodeVehicles,
  mergeSurvey,
  surveyToJSON,
  type FeedSurvey,
} from './rtdecode.js'

/**
 * What the regional feed actually contains.
 *
 * The entire observation design rests on assumptions about this feed that have to be
 * measured rather than assumed, because each one silently changes what a profile is worth:
 *
 * - If no producer sets `current_status`, there is no direct evidence that a vehicle ever
 *   stopped anywhere, actual times can only be inferred from predictions, and a
 *   prediction-error model trained on them measures how fast a predictor converges on
 *   itself rather than whether it was right.
 * - If `start_date` is absent, every trip's service day has to be inferred, and the failure
 *   mode is an entire day of error rather than a few seconds of it.
 * - If a producer republishes the timetable as its prediction, those trips are not evidence
 *   about anything and a board that presents them as live is claiming to know something it
 *   does not.
 *
 * Costs two 511 requests per sample. Run it for an hour before believing any of the
 * numbers in `docs/03-observation.md`:
 *
 *     npm run build && node dist/tools/forensics.js 60 30
 *
 * (samples, then seconds between them.)
 */

const samples = Number(process.argv[2] ?? 20)
const intervalSeconds = Number(process.argv[3] ?? 30)

const survey: FeedSurvey = new Map()
const profiled = new Set(config.profile.agencies)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function sample(i: number): Promise<void> {
  const [updates, vehicles] = await Promise.all([
    fetchUpstreamProtobuf('tripupdates', { agency: 'RG' }),
    fetchUpstreamProtobuf('vehiclepositions', { agency: 'RG' }),
  ])

  const cycle: FeedSurvey = new Map()
  // Null rather than the profiled set: the point of a survey is to find out what is there,
  // including for operators nobody has decided to profile yet.
  decodeTripUpdates(updates, null, cycle)
  decodeVehicles(vehicles, null, cycle)
  mergeSurvey(survey, cycle)

  console.info(`[forensics] sample ${i + 1}/${samples}: ${cycle.size} agencies`)
}

function report(): string {
  const json = surveyToJSON(survey)
  const rows = Object.entries(json).sort((a, b) => b[1].trips - a[1].trips)

  const lines: string[] = [
    '# Feed forensics',
    '',
    `Measured from ${samples} samples of the 511 regional feed, ${intervalSeconds}s apart,`,
    `ending ${new Date().toISOString()}.`,
    '',
    'Columns are cumulative counts across every sample, so they are useful as *ratios*',
    'rather than as absolute numbers.',
    '',
    '| agency | trips | vehicles | start_date | stop_sequence | current_status | ever STOPPED_AT | arr+dep | skipped | cancelled | schedule passthrough | tier A available |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ]

  for (const [agency, s] of rows) {
    lines.push(
      `| ${agency} | ${s.trips} | ${s.vehicles} | ${s.withStartDate} | ${s.withStopSequence} | ` +
        `${s.withCurrentStatus} | ${s.everStopped} | ${s.withArrivalAndDeparture} | ${s.skipped} | ` +
        `${s.canceled} | ${s.schedulePassthrough} | ${s.tierA ? '**yes**' : 'no'} |`,
    )
  }

  const profiledRows = rows.filter(([a]) => profiled.has(a))
  const withoutTierA = profiledRows.filter(([, s]) => !s.tierA).map(([a]) => a)

  lines.push(
    '',
    '## What this decides',
    '',
    withoutTierA.length === 0
      ? 'Every profiled agency reports `current_status` and is seen stopped, so direct ' +
        'observation is available for all of them and the prediction-error model can be ' +
        'trained without circularity.'
      : `**${withoutTierA.join(', ')} never report a vehicle as stopped.** For those ` +
        'agencies, actual times can only be inferred from the last prediction before a stop ' +
        'left the feed — which is a prediction, so training a prediction-error model on it ' +
        'would measure convergence rather than accuracy. Those agencies keep the ' +
        'schedule-deviation model, which is measured against the timetable and is therefore ' +
        'independent, and their prediction-error model stays disabled until a calibration ' +
        'against a direct source exists (see `docs/03-observation.md`).',
    '',
  )

  return lines.join('\n')
}

for (let i = 0; i < samples; i++) {
  try {
    await sample(i)
  } catch (err) {
    console.error('[forensics] sample failed:', (err as Error).message)
  }
  if (i < samples - 1) await sleep(intervalSeconds * 1000)
}

const path = process.env.FORENSICS_OUT ?? 'docs/feed-forensics.md'
await writeFile(path, report(), 'utf8')
console.info(`[forensics] wrote ${path}`)
await redis.quit().catch(() => undefined)
process.exit(0)
