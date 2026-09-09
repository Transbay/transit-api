import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simplifyDestination, stripVia, lineBadge, resolveRouteDestinations } from './names.js'

/**
 * Every string on the left of these assertions is a real value from the regional GTFS
 * feed, not an invented example. That matters: the rules in `names.ts` exist to fix
 * things this feed actually does, and a test built from imagined inputs would drift
 * away from it without ever failing.
 */

test('strips the mode from a station name', () => {
  // 91 headsigns in the feed end in " BART". Nobody says "I'm going to Rockridge BART".
  assert.equal(simplifyDestination('Rockridge BART'), 'Rockridge')
  assert.equal(simplifyDestination('Fruitvale BART'), 'Fruitvale')
  assert.equal(simplifyDestination('Union Landing Transit Center'), 'Union Landing')
  assert.equal(simplifyDestination('San Marin SMART Station'), 'San Marin')
})

test('fixes the feed\'s typography', () => {
  // Muni writes the apostrophe as a backtick, and "+" where riders read "&".
  assert.equal(simplifyDestination('Fisherman`s Wharf'), "Fisherman's Wharf")
  assert.equal(simplifyDestination('Church + Duboce'), 'Church & Duboce')
  assert.equal(simplifyDestination('WESTPORTAL'), 'West Portal')
})

test('shortens street types', () => {
  assert.equal(simplifyDestination('Geary + 33rd Avenue'), 'Geary & 33rd Ave')
  assert.equal(simplifyDestination('Vicente + 30th Avenue'), 'Vicente & 30th Ave')
  assert.equal(simplifyDestination('Mandana Blvd. & Lakeshore Ave.'), 'Mandana Blvd & Lakeshore Ave')
})

test('takes the first of a slash pair', () => {
  // "Caltrain/Ballpark" names two things at one place; riders say the first.
  assert.equal(simplifyDestination('Caltrain/Ballpark'), 'Caltrain')
})

test('overrides beat rules where a rule would be wrong', () => {
  // Here the slash lists via-points and the *last* segment is the terminal — the
  // opposite of Caltrain/Ballpark. No rule can tell these apart, so a human did.
  assert.equal(simplifyDestination('SFO / SF / Antioch'), 'Antioch')
  assert.equal(simplifyDestination('San Francisco International Airport'), 'SFO')
  assert.equal(simplifyDestination('Berryessa/North San Jose'), 'Berryessa')
  assert.equal(simplifyDestination('Millbrae (Caltrain Transfer Platform)'), 'Millbrae')
})

test('leaves a name that is already fine alone', () => {
  // "Some will need to stay long" — the goal is neatness, not brevity for its own sake.
  for (const s of ['Ocean Beach', 'Berkeley Marina', 'Daly City', 'San Francisco', 'Novato']) {
    assert.equal(simplifyDestination(s), s)
  }
})

test('empty and missing input never produce a label', () => {
  assert.equal(simplifyDestination(''), '')
  assert.equal(simplifyDestination(undefined), '')
  assert.equal(simplifyDestination(null), '')
  assert.equal(simplifyDestination('   '), '')
})

test('badge prefers the short name, falls back sanely', () => {
  assert.equal(lineBadge('N', 'Judah', 'SF:N'), 'N')
  assert.equal(lineBadge('51B', 'Berkeley Amtrak - Rockridge', 'AC:51B'), '51B')
  // Caltrain's short names are service classes, and that is genuinely what riders
  // distinguish trains by — so they stay.
  assert.equal(lineBadge('Local Weekday', '', 'CT:Local Weekday'), 'Local Weekday')
  assert.equal(lineBadge('', 'South County', 'CT:South County'), 'South County')
  assert.equal(lineBadge('', '', 'AC:12'), '12')
})

test('stripVia removes only the trailing clause', () => {
  assert.equal(stripVia('Northgate via San Rafael'), 'Northgate')
  assert.equal(stripVia('Canal'), 'Canal')
})

// ---------------------------------------------------------------------------
// The part that protects riders rather than tidying strings
// ---------------------------------------------------------------------------

test('drops the via when the directions stay distinguishable', () => {
  // Marin's 30: "San Rafael via Canal" / "Canal via San Rafael". Strip both vias and
  // you still have two different answers, so the strip is free.
  const out = resolveRouteDestinations(['San Rafael via Canal', 'Canal via San Rafael'])
  assert.equal(out.get('San Rafael via Canal'), 'San Rafael')
  assert.equal(out.get('Canal via San Rafael'), 'Canal')
})

test('KEEPS the via when dropping it would make two branches identical', () => {
  // Marin's 35 has two Northgate branches. Simplified to "Northgate" they would be
  // indistinguishable, and a rider at the stop could not tell which bus was theirs.
  // A long label beats a wrong one; this is the one place that trade-off is decided.
  const out = resolveRouteDestinations([
    'Northgate via San Rafael',
    'Northgate via Terra Linda HS',
    'Canal',
  ])
  assert.equal(out.get('Northgate via San Rafael'), 'Northgate via San Rafael')
  assert.equal(out.get('Northgate via Terra Linda HS'), 'Northgate via Terra Linda HS')
  assert.equal(out.get('Canal'), 'Canal')
})

test('unifying two spellings of one place is intended, not a collision', () => {
  // The feed writes the same destination both ways. Collapsing them is the correct
  // outcome — the failure mode we guard against is two *different* places sharing a
  // label, which the test above covers.
  const out = resolveRouteDestinations(['Daly City', 'Daly City BART'])
  assert.equal(out.get('Daly City'), 'Daly City')
  assert.equal(out.get('Daly City BART'), 'Daly City')
})

test('a headsign that is nothing but a via never becomes blank', () => {
  const out = resolveRouteDestinations(['via Downtown'])
  assert.notEqual(out.get('via Downtown'), '')
})
