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
  },

  /**
   * Corrected predictions.
   *
   * `off` computes nothing. `shadow` computes and records but reports every prediction at
   * `confidence: none` with `predicted == raw`. `on` lets the evidence decide, per agency
   * and per horizon, via the promotion gate in `score.ts`.
   *
   * None of these settings can change `/v1/departures`, which serves raw agency times in
   * every mode. Corrections live on `/v1/predictions` only.
   */
  predictions: {
    mode: (() => {
      const raw = optional('PREDICTION_MODE', 'shadow')
      return raw === 'on' || raw === 'off' ? raw : ('shadow' as const)
    })() as 'off' | 'shadow' | 'on',
    /** Effective samples below which a segment never offers a correction. */
    minSamples: Number(optional('PREDICTION_MIN_SAMPLES', '3')),
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
