/** Every environment-supplied value enters the process here and nowhere else. */

/** Names of variables that were missing or empty, collected rather than thrown on. */
const missing: string[] = []

/**
 * An empty value counts as missing. A variable declared with a blank value is the
 * single most common way to misconfigure this — the name is visibly present in the
 * dashboard, so it looks set — and an empty JWT secret or API key is never something
 * we should boot with.
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    missing.push(name)
    return ''
  }
  return value
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback
}

/** The 511 keys, as a pool. */
function apiKeyPool(): string[] {
  const raw = required('FIVEELEVEN_API_KEYS')
  // A blank value was already recorded by `required`; don't also report it as
  // malformed, which would be two complaints about one mistake.
  if (!raw) return []

  const keys = raw
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
  if (keys.length === 0) throw new Error('FIVEELEVEN_API_KEYS contained no usable keys')
  return keys
}

export const config = {
  port: Number(optional('PORT', '8080')),

  /** Railway injects this when you add the Redis plugin. */
  redisUrl: required('REDIS_URL'),

  fiveEleven: {
    keys: apiKeyPool(),
    /** Overridable so tests can point at a local stub instead of the real 511. */
    baseUrl: optional('FIVEELEVEN_BASE_URL', 'https://api.511.org/transit/'),
    /** Per key, per hour. */
    hourlyLimitPerKey: Number(optional('FIVEELEVEN_HOURLY_LIMIT', '60')),
  },

  appAttest: {
    /** Your Apple Developer team ID — the prefix in "TEAMID.bundle.id". */
    teamId: required('APPLE_TEAM_ID'),
    /** Must match the app target's bundle identifier exactly. */
    bundleId: required('APP_BUNDLE_ID'),
    /**
     * Attestations from a debug build are signed under Apple's *development*
     * environment and carry a different AAGUID. Set to true only for builds you
     * run from Xcode; a production deploy must leave this false or anyone with a
     * development-signed build can mint tokens.
     */
    allowDevelopmentAttestations: optional('ALLOW_DEV_ATTESTATION', 'false') === 'true',
  },

  mapkit: {
    /**
     * MapKit JS. Absent configuration disables the maps and nothing else -- the pages that
     * use them fall back to their tables, because a missing map is a worse page and a
     * broken deploy is a worse day.
     */
    /** From Apple Developer -> Keys, on a key with MapKit JS enabled. Not a secret. */
    keyId: optional('MAPKIT_KEY_ID', ''),
    /** The same Apple Developer team as App Attest unless deliberately overridden. */
    teamId: optional('MAPKIT_TEAM_ID', process.env.APPLE_TEAM_ID ?? ''),
    /**
     * The contents of the .p8 file. A private key: it belongs in a Railway variable and
     * must never reach the repository. Stored with real newlines or with the escaped `\n`
     * that pasting through a form tends to produce; both are accepted.
     */
    privateKey: optional('MAPKIT_PRIVATE_KEY', '').replace(/\\n/g, '\n').trim(),
    /**
     * Which page origins may be handed a token.
     *
     * The `origin` claim is what stops a token lifted from these open pages being used to
     * spend the quota elsewhere, so it cannot be derived from the request -- a caller who
     * controls the Host header would simply mint themselves a matching one. It is an
     * allowlist, checked against the browser's Origin header.
     */
    origins: optional(
      'MAPKIT_ORIGINS',
      'https://transitapi.transbay.dev,https://transitapi-production.up.railway.app',
    )
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    /** Short, because the page refreshes it and a leaked token should expire quickly. */
    ttlSeconds: Number(optional('MAPKIT_TOKEN_TTL_SECONDS', '1800')),
  },

  auth: {
    /** Signs the session tokens we hand out after a successful attestation. */
    jwtSecret: required('JWT_SECRET'),
    /** How long a device can keep calling before it must attest again. */
    sessionTtlDays: Number(optional('SESSION_TTL_DAYS', '30')),
    /**
     * An escape hatch for the Simulator, which cannot do App Attest at all.
     * Leave unset in production — if it is set, anyone holding this string is a
     * fully trusted client.
     */
    devBypassToken: process.env.DEV_BYPASS_TOKEN || null,
  },

  /** How long a cached response stays fresh, in seconds. */
  ttl: {
    /**
     * Raised from 25s once the app started refreshing every saved stop rather than the
     * nearest few. The client re-asks on a 30s cycle, so this sits just above it and
     * most of those re-asks land on a cache hit instead of a 511 request. Departure
     * predictions are quoted in whole minutes; 45s of age is not visible.
     */
    departures: 45,
    patterns: 60 * 60 * 24,
    stops: 60 * 60 * 24,
    lines: 60 * 60 * 24,
    operators: 60 * 60 * 24 * 7,
  },

  /**
   * Server-side polling: keep every agency's departures current on our own schedule, so a
   * client request becomes a Redis lookup instead of a 511 request.
   */
  poll: {
    enabled: optional('POLL_ENABLED', 'true') === 'true',
    /**
     * `rg` — one regional GTFS-RT sweep covering every agency (the default).
     * `siri` — the previous per-agency SIRI sweep, for fallback only.
     */
    mode: optional('POLL_MODE', 'rg') === 'siri' ? ('siri' as const) : ('rg' as const),
    /**
     * 511 operator IDs whose snapshots we publish, or `*` for every operator the
     * regional feed carries.
     *
     * `*` is the default and costs nothing: the two protobufs already contain all
     * twenty-four operators, so filtering them out saves a little Redis and no requests
     * at all. Discovering the list from the feed rather than hard-coding it means an
     * operator joining 511 appears on its own, and one leaving stops being reported as
     * missing.
     */
    agencies: optional('POLLED_AGENCIES', '*')
      .split(',')
      .map((a) => a.trim())
      .filter((a) => Boolean(a) && a !== '*'),
    /** True when no explicit list was given, so every agency in the feed is published. */
    allAgencies: optional('POLLED_AGENCIES', '*').split(',').some((a) => a.trim() === '*'),
    /** Seconds between sweeps. */
    intervalSeconds: Number(optional('POLL_INTERVAL_SECONDS', '15')),
    /**
     * Hours between static GTFS rebuilds.
     *
     * Route names and headsigns change when a service change ships — a few times a
     * year — so daily is already far more often than needed. It is one request.
     */
    staticRefreshHours: Number(optional('STATIC_REFRESH_HOURS', '24')),
    /** Whether to index the regional vehicle-position feed. `rg` mode only. */
    vehicles: optional('POLL_VEHICLES', 'true') === 'true',
    /**
     * Whether the stop a user is actually looking at may still fetch on demand when the
     * snapshot has aged past `onDemandAfterSeconds`.
     */
    hybrid: optional('ON_DEMAND_ENABLED', 'false') === 'true',
    /** How stale a snapshot must be before a live request is worth spending. */
    onDemandAfterSeconds: Number(optional('ON_DEMAND_AFTER_SECONDS', '45')),
  },

  /**
   * The delay profile: the historical half of this service.
   *
   * Every value is optional and the whole subsystem is off by default in the sense that
   * matters — with no `DATABASE_URL` it never runs, and the live departures path is
   * identical either way. Nothing under here may become a dependency of `/v1/departures`.
   */
  profile: {
    enabled: optional('PROFILE_ENABLED', 'true') === 'true',
    /**
     * Which operators get a history.
     *
     * Deliberately a short list rather than everything the feed carries. Learning a
     * profile means storing a stop-level event for every vehicle at every stop all day,
     * and there is no reason to pay that for an operator nobody has asked about. These
     * five are the ones the app's users actually save.
     */
    agencies: optional('PROFILED_AGENCIES', 'SF,BA,CT,SM,GG')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
    /**
     * How fast the profile forgets. Three weeks: long enough to survive a quiet fortnight
     * on a Sunday route, short enough that a signal retimed in March stops arguing in June.
     */
    halfLifeDays: Number(optional('PROFILE_HALF_LIFE_DAYS', '21')),
    /**
     * Within-day correlation between consecutive trips on a route.
     *
     * Used to discount sample sizes. Consecutive trips ten minutes apart share nearly all
     * their causes, so counting them as independent observations inflates every n in the
     * system and makes every confidence interval too narrow. Measured per agency once
     * there is enough history; this is the prior.
     */
    icc: Number(optional('PROFILE_ICC', '0.5')),
    /** Seconds after its published time a held vehicle actually leaves a timepoint. */
    holdOffsetSeconds: Number(optional('PROFILE_HOLD_OFFSET', '12')),
    /** How often the learner folds new observations into the profile. */
    learnIntervalSeconds: Number(optional('PROFILE_LEARN_INTERVAL', '300')),
    /** How often buffered observations are flushed to the warehouse. */
    flushIntervalSeconds: Number(optional('PROFILE_FLUSH_INTERVAL', '30')),
    /** Days of raw stop-level history kept before the daily partition is dropped. */
    retentionDays: Number(optional('PROFILE_RETENTION_DAYS', '90')),
    /**
     * How much of the event stream may back up in Redis before the oldest is dropped.
     *
     * Losing history is always preferable to delaying a departure, and this is where that
     * rule is enforced rather than merely stated.
     */
    streamMaxLen: Number(optional('PROFILE_STREAM_MAXLEN', '200000')),
    /**
     * Route profiles kept unpacked in memory for predictions, most recently used.
     *
     * Each is ~2 MB unpacked (measured: an average 430 KB blob unpacks to 1.8-2.6 MB), and
     * one stop's predictions touch two per route serving it -- its day type and the pooled
     * rung. 32 is ~55-85 MB. Past it, the least recently used is re-read from Redis when
     * next asked for, which costs a round trip rather than memory.
     */
    cacheRoutes: Number(optional('PROFILE_CACHE_ROUTES', '32')),
  },

  /**
   * Corrected predictions.
   *
   * `off` computes nothing. `shadow` computes and records but reports every prediction at
   * `confidence: none` with `predicted == raw`. `on` lets the evidence decide, per agency
   * and per horizon, via the promotion gate in `score.ts`.
   *
   * None of `mode` or `minSamples` changes `/v1/departures`, which serves raw agency times
   * unless `correctDepartures` is on as well.
   */
  predictions: {
    mode: (() => {
      const raw = optional('PREDICTION_MODE', 'shadow')
      return raw === 'on' || raw === 'off' ? raw : ('shadow' as const)
    })() as 'off' | 'shadow' | 'on',
    /** Effective samples below which a segment never offers a correction. */
    minSamples: Number(optional('PREDICTION_MIN_SAMPLES', '3')),
    /**
     * The point of learning is a good number while the bus is still far away. Inside this
     * many seconds the agency's own time -- by then mostly GPS and a few stops of road --
     * stands, on the boards and in the app, rather than being nudged every refresh.
     */
    minHorizonSeconds: Number(optional('PREDICTION_MIN_HORIZON_SECONDS', '300')),
    /** Corrections smaller than this are noise to a rider and are not shown or applied. */
    minCorrectionSeconds: Number(optional('PREDICTION_MIN_CORRECTION_SECONDS', '60')),
    /**
     * Whether `/v1/departures` itself carries the corrections, in its usual SIRI envelope.
     *
     * Off by default because that response is what every shipped app build reads. On, only
     * the expected times of profiled agencies move, and only where `/v1/predictions` would
     * claim the correction at `BRIDGE_MIN_CONFIDENCE` or better -- so it also needs
     * `PREDICTION_MODE=on`, without which every confidence is `shadow` and nothing moves.
     * Turning it off again returns the agency's raw times on the next request.
     */
    correctDepartures: optional('DEPARTURES_CORRECTED', 'false') === 'true',
  },

  /**
   * Random spot checks of predictions against what the vehicle then did (`accuracy.ts`).
   *
   * Only predictions already computed for a request are sampled, so this adds no
   * prediction work; the cost is one small Redis hash and a row per resolved check.
   */
  accuracy: {
    /** Chance that a computed stop's predictions contribute one check. `0` turns it off. */
    sampleRate: Number(optional('ACCURACY_SAMPLE_RATE', '0.1')),
    /** Checks waiting on their vehicle, at most. Past it, sampling pauses. */
    maxPending: Number(optional('ACCURACY_MAX_PENDING', '2000')),
    /**
     * Checks over the last fortnight, per agency and horizon, before our time may be shown
     * in place of the agency's -- and then only where our median miss is the smaller.
     */
    minChecks: Number(optional('ACCURACY_MIN_CHECKS', '50')),
  },

  /**
   * The warehouse. Railway sets `DATABASE_URL` when you add the Postgres plugin.
   *
   * Absent is a supported configuration, not a broken one: the service boots, serves every
   * existing endpoint, and simply learns nothing.
   */
  warehouse: {
    url: process.env.DATABASE_URL || null,
    poolSize: Number(optional('DATABASE_POOL_SIZE', '4')),
    /** Skip schema migration at boot. For a replica that must not race the leader. */
    migrate: optional('DATABASE_MIGRATE', 'true') === 'true',
  },

  /**
   * BART's own APIs, used alongside 511 because BART is the one operator that
   * publishes no vehicle positions anywhere — not to 511, and not in its own GTFS-RT.
   *
   * Every value is `optional()`. A missing BART variable must never stop the other 23
   * operators from booting.
   */
  bart: {
    enabled: optional('BART_ENABLED', 'true') === 'true',
    /**
     * Needed only by `etd.aspx` (platform, car count, delay, "Leaving"). The GTFS-RT
     * feed needs no key at all.
     *
     * The default is BART's widely published open key, which makes local development
     * work with no signup — but it is shared with every tutorial on the internet, on
     * an API BART itself labels "legacy". Register your own before this carries
     * production traffic.
     */
    apiKey: optional('BART_API_KEY', 'MW9S-E7SL-26DU-VV8V'),
    baseUrl: optional('BART_BASE_URL', 'https://api.bart.gov/api/'),
    gtfsRtUrl: optional('BART_GTFSRT_URL', 'https://api.bart.gov/gtfsrt/tripupdate.aspx'),
    /** ETD is fetched every Nth poll cycle; it changes slower than positions do. */
    etdIntervalSeconds: Number(optional('BART_ETD_INTERVAL_SECONDS', '30')),
    /**
     * Whether to place BART trains on the map by interpolating between their predicted
     * stop times. There is no other way to get a BART position.
     */
    synthesizeVehicles: optional('BART_SYNTHESIZE_VEHICLES', 'true') === 'true',
    /**
     * Merge BART's own trip feed with 511's.
     *
     * Off, and it should stay off without a reason. BART publishes ~70 trips to 511's
     * ~60, but the departure board and the map must be derived from the *same* numbers
     * or they will disagree — a train drawn between two stations while the board says
     * it already left. Ten extra trips is not worth that.
     */
    ownTripUpdates: optional('BART_OWN_TRIPUPDATES', 'false') === 'true',
    /** Well inside the poll interval, so a hung BART costs one cycle's enrichment. */
    timeoutMs: 6000,
  },

  /**
   * The bridge to the Go `headways-server`, which reads these keys instead of polling
   * 511 itself.
   *
   * Additive in the same sense the profile is: every write is wrapped, none of it sits on
   * the path of a response, and turning it off returns this service to exactly what it
   * was. The one rule that matters is that `hw:vp` and `hw:tu` carry the **unmodified**
   * 511 protobuf. The consumer's `proto.Unmarshal` is the contract, so reshaping those
   * bytes is a new key and a version bump, never an edit.
   */
  bridge: {
    enabled: optional('BRIDGE_ENABLED', 'false') === 'true',
    /**
     * Which region these feeds represent. `sfbay` is the only producer today; SacRT and
     * Elk Grove would write their own keys under the same scheme rather than needing a
     * different one.
     */
    region: optional('BRIDGE_REGION', 'sfbay'),
    /**
     * Whether to publish corrected departure times alongside the raw feeds.
     *
     * Separate from `enabled` on purpose: swapping where headways gets its bytes, and
     * changing what those bytes *say*, are two different risks and should be reversible
     * independently.
     */
    corrections: optional('BRIDGE_CORRECTIONS', 'false') === 'true',
    /**
     * Lower than the snapshot TTL. A stale departure board is a nuisance; a stale vehicle
     * position is a bus drawn on a street it left ten minutes ago, so these expire rather
     * than linger.
     */
    ttlSeconds: Number(optional('BRIDGE_TTL_SECONDS', '90')),
    /**
     * Only corrections this confident reach the map. Below it the agency's own number is
     * left alone, so the bridge can never make a displayed time worse than it is today.
     */
    minConfidence: optional('BRIDGE_MIN_CONFIDENCE', 'medium'),
    /**
     * Whether to publish BART's synthesised trains on `hw:vpx`, so they appear on the map.
     *
     * Its own switch because it is the one bridge output that is inferred rather than
     * relayed: turning it off takes BART off the map and leaves every measured vehicle
     * exactly where it was.
     */
    synthVehicles: optional('BRIDGE_SYNTH_VEHICLES', 'true') === 'true',
    /** Bumped when the shape of any bridge key changes. Consumers refuse what they don't know. */
    version: 1,
  },

  /**
   * Multiplier on each TTL for the "stale" copy we keep as a safety net. A stop's
   * departures stay fresh for 25s but remain *servable* for 25 * 20 = ~8 minutes,
   * so an upstream outage degrades the widget instead of breaking it.
   */
  staleMultiplier: 20,
} as const

/** Checked after the whole object is built, so one boot reports every problem. */
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
      `Set ${missing.length > 1 ? 'them' : 'it'} on the service and redeploy. ` +
      `Note that a variable declared with an empty value counts as missing.`,
  )
}

export type Config = typeof config
