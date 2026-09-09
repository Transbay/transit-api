/**
 * Just enough of 511's SIRI StopMonitoring shape to split an agency-wide response into
 * per-stop buckets.
 */

export interface MonitoredStopVisit {
  MonitoringRef?: unknown
  [key: string]: unknown
}

export interface SIRIResponse {
  ServiceDelivery?: {
    ResponseTimestamp?: string
    StopMonitoringDelivery?: {
      ResponseTimestamp?: string
      MonitoredStopVisit?: MonitoredStopVisit[]
    }
  }
}

/**
 * 511 writes the same logical string three different ways depending on the agency and the
 * field: a bare string, a one-element array of strings, or a one-element array of `{ value }`
 * objects.
 */
export function flexibleString(raw: unknown): string | null {
  if (typeof raw === 'string') return raw || null
  if (typeof raw === 'number') return String(raw)

  if (Array.isArray(raw)) {
    const first = raw[0]
    if (typeof first === 'string') return first || null
    if (first && typeof first === 'object') {
      const value = (first as Record<string, unknown>).value
      if (typeof value === 'string') return value || null
      const fallback = Object.values(first as Record<string, unknown>)[0]
      return typeof fallback === 'string' && fallback ? fallback : null
    }
    return null
  }

  // Not a shape FlexibleString accepts, but cheap to tolerate and harmless if 511
  // ever settles on the obvious one.
  if (raw && typeof raw === 'object') {
    const value = (raw as Record<string, unknown>).value
    if (typeof value === 'string') return value || null
  }

  return null
}

/** Wraps per-stop visits back into the envelope the app's decoder expects. */
export function envelope(visits: MonitoredStopVisit[], responseTimestamp?: string): SIRIResponse {
  return {
    ServiceDelivery: {
      ResponseTimestamp: responseTimestamp,
      StopMonitoringDelivery: {
        ResponseTimestamp: responseTimestamp,
        MonitoredStopVisit: visits,
      },
    },
  }
}

export interface GroupedAgency {
  /** Stop code → that stop's visits, already JSON-encoded for a direct HSET. */
  byStop: Map<string, MonitoredStopVisit[]>
  responseTimestamp?: string
  /** Visits the feed included but that carried no usable MonitoringRef. */
  dropped: number
}

/**
 * Splits one agency-wide response into per-stop buckets.
 *
 * This is the whole point of the poller: one request covering thousands of stops,
 * indexed once, then read by stop code for free.
 */
export function groupByStop(response: SIRIResponse): GroupedAgency {
  const delivery = response.ServiceDelivery?.StopMonitoringDelivery
  const visits = delivery?.MonitoredStopVisit ?? []

  const byStop = new Map<string, MonitoredStopVisit[]>()
  let dropped = 0

  for (const visit of visits) {
    const stopCode = flexibleString(visit?.MonitoringRef)
    if (!stopCode) {
      dropped++
      continue
    }
    const bucket = byStop.get(stopCode)
    if (bucket) bucket.push(visit)
    else byStop.set(stopCode, [visit])
  }

  return {
    byStop,
    responseTimestamp:
      delivery?.ResponseTimestamp ?? response.ServiceDelivery?.ResponseTimestamp,
    dropped,
  }
}
