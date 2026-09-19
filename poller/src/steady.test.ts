import test from 'node:test'
import assert from 'node:assert/strict'

process.env.REDIS_URL ??= 'redis://127.0.0.1:1'
process.env.FIVEELEVEN_API_KEYS ??= 'x'
process.env.APPLE_TEAM_ID ??= 'x'
process.env.APP_BUNDLE_ID ??= 'x'
process.env.JWT_SECRET ??= 'x'
const { worthShowing } = await import('./steady.js')

test('a correction starts at the threshold and stays until clearly gone', () => {
  const k = 'SF|15419|t1'
  assert.equal(worthShowing(k, 25, 0), false, 'under 30s does not start')
  assert.equal(worthShowing(k, 60, 1000), true, "the N's minute is shown")
  assert.equal(worthShowing(k, 28, 2000), true, 'hovering under 30s does not flicker off')
  assert.equal(worthShowing(k, -20, 3000), true)
  assert.equal(worthShowing(k, 10, 4000), false, 'below half the threshold it goes')
  assert.equal(worthShowing(k, 28, 5000), false, 'and must clear the full bar to return')
})
