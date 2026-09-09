// Turns GTFS route and headsign strings into something that fits on a badge.
// Overrides first, then rules; when a rule gets a case wrong, add an override.

/** Destinations we name by hand. */
const OVERRIDES: Record<string, string> = {
  // BART. Twenty headsigns total, so hand-naming them all is cheap and exact.
  'SFO / SF / Antioch': 'Antioch',
  'San Francisco International Airport': 'SFO',
  'Berryessa/North San Jose': 'Berryessa',
  'Millbrae (Caltrain Transfer Platform)': 'Millbrae',
  'Dublin/Pleasanton': 'Dublin',
  'Bus Bridge': 'Bus Bridge',

  // Muni.
  WESTPORTAL: 'West Portal',
  'Caltrain/Ballpark': 'Caltrain',
  'Bayview District - Hudson & Newhall': 'Bayview',

  // Caltrain. "Diridon" is the platform; "San Jose" is where people are going.
  'San Jose Diridon': 'San Jose',

  // Golden Gate. Both of these lead with "San Francisco", which is not information
  // on a bus that only goes to San Francisco.
  'San Francisco Salesforce TC': 'Salesforce',
  'San Francisco Financial District': 'Financial District',

  // AC Transit.
  'Oakland Amtrak at Jack London Square': 'Jack London Sq',
  'Warm Springs/South Fremont BART': 'Warm Springs',
  'University Village, Albany': 'University Village',
  'Public Market Emeryville': 'Public Market',
}

/** Suffixes that describe what a place *is* rather than where it is. */
const REDUNDANT_SUFFIXES = [
  ' SMART Station',
  ' Transit Center',
  ' Transit Ctr',
  ' Station',
  ' BART',
  ' Caltrain',
  ' TC',
]

/** Long forms that cost badge width and buy nothing. */
const ABBREVIATIONS: [RegExp, string][] = [
  [/\bAvenue\b/g, 'Ave'],
  [/\bStreet\b/g, 'St'],
  [/\bBoulevard\b/g, 'Blvd'],
  [/\bParkway\b/g, 'Pkwy'],
  [/\bRoad\b/g, 'Rd'],
  [/\bDrive\b/g, 'Dr'],
  [/\bSquare\b/g, 'Sq'],
  [/\bJunction\b/g, 'Jct'],
  [/\bInternational\b/g, "Int'l"],
  // GTFS writes these with a trailing period about half the time; normalise both.
  [/\bAve\./g, 'Ave'],
  [/\bSt\./g, 'St'],
  [/\bBlvd\./g, 'Blvd'],
  [/\bRd\./g, 'Rd'],
  [/\bDr\./g, 'Dr'],
]

/** One headsign, cleaned. */
export function simplifyDestination(raw: string | undefined | null): string {
  if (!raw) return ''

  const trimmed = raw.trim().replace(/\s+/g, ' ')
  if (!trimmed) return ''

  // An override is a decision already made. Nothing below may second-guess it.
  const override = OVERRIDES[trimmed]
  if (override !== undefined) return override

  let s = trimmed

  // 1. Typography. Muni's feed uses a backtick for the apostrophe in "Fisherman`s
  //    Wharf", and "+" where riders read "&".
  s = s.replace(/`/g, "'")
  s = s.replace(/\s*\+\s*/g, ' & ')
  s = s.replace(/\s*&\s*/g, ' & ')

  // 2. Parentheticals are always operator detail — platform names, transfer notes.
  s = s.replace(/\s*\([^)]*\)/g, '').trim()

  // 3. A single all-caps word is a feed typo, not emphasis ("WESTPORTAL"). Multi-word
  //    caps strings are usually acronyms we want to keep (SFO, ECR, TC), so only the
  //    single-token case is touched.
  if (/^[A-Z]{6,}$/.test(s)) s = s[0] + s.slice(1).toLowerCase()

  // 4. "A - B" is a district followed by an intersection; the district is the answer.
  const dash = s.split(/\s+-\s+/)
  if (dash.length > 1 && dash[0].length >= 4) s = dash[0].trim()

  // 5. Redundant suffixes, longest first so the specific ones win.
  for (const suffix of REDUNDANT_SUFFIXES) {
    if (s.length > suffix.length && s.toLowerCase().endsWith(suffix.toLowerCase())) {
      s = s.slice(0, -suffix.length).trim()
      break
    }
  }

  // 6. Abbreviations.
  for (const [pattern, replacement] of ABBREVIATIONS) s = s.replace(pattern, replacement)

  // 7. "A/B" names two things at one place. The first is the one people use — and
  //    the exceptions to that ("SFO / SF / Antioch") are all overrides above.
  if (s.includes('/')) {
    const first = s.split('/')[0].trim()
    if (first.length >= 3) s = first
  }

  return s.replace(/\s+/g, ' ').trim()
}

/** Strips a trailing " via Somewhere". */
export function stripVia(s: string): string {
  return s.replace(/\s+via\s+.*$/i, '').trim()
}

/** The badge text for a route. */
export function lineBadge(
  shortName: string | undefined | null,
  longName: string | undefined | null,
  routeId: string,
): string {
  const short = (shortName ?? '').trim()
  if (short) return short

  const long = (longName ?? '').trim()
  if (long) return long

  // Last resort: the agency-qualified id, minus the qualifier ("AC:12" -> "12").
  const colon = routeId.indexOf(':')
  return colon >= 0 ? routeId.slice(colon + 1) : routeId
}

/** Names every destination on one route at once, so collisions can be seen. */
export function resolveRouteDestinations(headsigns: Iterable<string>): Map<string, string> {
  const originals = [...new Set([...headsigns].map((h) => h.trim()).filter(Boolean))]

  // Pass one: the full cleanup, vias included.
  const bold = new Map<string, string>()
  for (const h of originals) bold.set(h, simplifyDestination(stripVia(h)))

  // Pass two: the same cleanup with vias kept, as the fallback for anything that
  // collided above.
  const safe = new Map<string, string>()
  for (const h of originals) safe.set(h, simplifyDestination(h))

  // Which bold labels are claimed by more than one headsign?
  const counts = new Map<string, number>()
  for (const label of bold.values()) counts.set(label, (counts.get(label) ?? 0) + 1)

  const out = new Map<string, string>()
  for (const h of originals) {
    const label = bold.get(h)!
    const ambiguous = !label || (counts.get(label) ?? 0) > 1
    // The safe form can be empty too (a headsign that was nothing but a via); the
    // raw string is always better than a blank badge.
    out.set(h, ambiguous ? safe.get(h) || h : label)
  }
  return out
}
