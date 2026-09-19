/**
 * The judgement calls in `accuracy.ts`, kept free of config and I/O so they can be tested
 * on their own. All times are epoch seconds.
 */

/**
 * What one pending check's vehicle has done, given whether its trip is still listed at the
 * stop (`latest`, the agency's current time for it) and the time now.
 *
 * Gone from the stop and due when last seen means it left, and the agency's last time is
 * the actual. A brief gap in a trip's updates looks the same, which is why "due" is
 * required and the last sighting must be recent.
 */
export function decide(
  p: { at: number; last: number; seenAt: number },
  latest: number | undefined,
  now: number,
): 'seen' | 'departed' | 'vanished' | 'expired' | 'wait' {
  if (latest !== undefined) return 'seen'
  if (p.last <= p.seenAt + 120 && now - p.seenAt <= 180) return 'departed'
  // Left the feed while still minutes away, and never came back.
  if (now - p.seenAt > 600) return 'vanished'
  if (now - p.at > 7200) return 'expired'
  return 'wait'
}

/** Horizon bucket, matching `rollUpAccuracy`: upper edge in minutes. */
export function horizonBucket(seconds: number): number {
  if (seconds <= 300) return 5
  if (seconds <= 600) return 10
  if (seconds <= 900) return 15
  if (seconds <= 1200) return 20
  return 30
}
